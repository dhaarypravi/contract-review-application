import { llmConfig } from "@/config";

/**
 * One client for both providers: each exposes the OpenAI request shape, so the
 * difference is a base URL, a key and two model ids (see src/config.ts).
 */

export type LlmErrorKind = "not_configured" | "rate_limited" | "daily_limit" | "busy" | "rejected";

/** `message` is written for the user. `detail` is for the server log only. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly detail = "",
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Reasoning models spend part of this before answering, so keep it generous. */
  maxTokens?: number;
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 90_000;
/** Mutable so that tests do not wait. */
export const retryPolicy = { baseMs: 1000 };
const EMBEDDING_BATCH = 64;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function chat(turns: ChatTurn[], options: ChatOptions = {}): Promise<string> {
  const config = llmConfig();
  return withRetry(async () => {
    const response = await post("/chat/completions", chatBody(config.chatModel, turns, options, false), options.signal);
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string };
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    // A throttled free tier can answer an empty 200 instead of a 429.
    if (!content) throw busy(`empty completion ${JSON.stringify(body).slice(0, 500)}`);
    return content;
  }, options.signal);
}

/** Yields text as it arrives. Retries only before the first token. */
export async function* chatStream(turns: ChatTurn[], options: ChatOptions = {}): AsyncGenerator<string> {
  const config = llmConfig();
  const { iterator, first } = await withRetry(async () => {
    const response = await post("/chat/completions", chatBody(config.chatModel, turns, options, true), options.signal);
    const iterator = readDeltas(response);
    const first = await iterator.next();
    if (first.done) throw busy("empty stream");
    return { iterator, first };
  }, options.signal);

  try {
    yield first.value;
    yield* iterator;
  } finally {
    await iterator.return(undefined);
  }
}

/** Embeds in batches, preserving order, and checks the width before it reaches SQL. */
export async function embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const config = llmConfig();
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH);
    const result = await withRetry(async () => {
      const response = await post(
        "/embeddings",
        {
          model: config.embeddingModel,
          input: batch,
          ...(config.canRequestDimensions ? { dimensions: config.embeddingDimensions } : {}),
        },
        signal,
      );
      const body = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
      const data = body.data ?? [];
      if (data.length !== batch.length) throw busy(`expected ${batch.length} embeddings, got ${data.length}`);
      return data
        .map((row, position) => ({ index: row.index ?? position, embedding: row.embedding ?? [] }))
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);
    }, signal);

    for (const vector of result) {
      if (vector.length !== config.embeddingDimensions) {
        throw new LlmError(
          "rejected",
          "The embedding model returned an unexpected result. Check the embedding settings.",
          `${config.embeddingModel} returned ${vector.length} dimensions, expected ${config.embeddingDimensions}`,
        );
      }
    }
    vectors.push(...result);
  }
  return vectors;
}

function chatBody(model: string, messages: ChatTurn[], options: ChatOptions, stream: boolean) {
  return { model, messages, temperature: 0, max_tokens: options.maxTokens ?? 1500, stream };
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const config = llmConfig();
  if (!config.apiKey) {
    throw new LlmError("not_configured", `No model provider key is set. Add ${config.keyName} to .env and restart.`);
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(config.baseUrl + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw busy(`network: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw toLlmError(response.status, response.headers, await response.text());
  return response;
}

function busy(detail: string, retryAfterSeconds?: number) {
  return new LlmError("busy", "The AI service is busy right now. Please try again in a minute.", detail, retryAfterSeconds);
}

/** Exported for tests. Maps a provider failure to a sentence a person can act on. */
export function toLlmError(status: number, headers: Headers, body: string): LlmError {
  const detail = `${status} ${body.slice(0, 1000)}`;
  const retryAfter = Number(headers.get("retry-after")) || undefined;

  if (status === 429) {
    if (/per[-_ ]?day|perday|daily/i.test(body)) {
      return new LlmError(
        "daily_limit",
        "The AI service's free daily limit has been reached. Try again after it resets, or use another provider key (see the README).",
        detail,
      );
    }
    return new LlmError(
      "rate_limited",
      "The AI service is rate-limiting requests. Please wait a minute and try again.",
      detail,
      retryAfter,
    );
  }
  if (status === 401 || status === 403) {
    return new LlmError("not_configured", "The model provider rejected the API key. Check the key in .env.", detail);
  }
  if (status === 408 || status >= 500) return busy(detail, retryAfter);
  return new LlmError("rejected", "The AI service could not process this request.", detail);
}

async function withRetry<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retryable = error instanceof LlmError && (error.kind === "busy" || error.kind === "rate_limited");
      if (!retryable || attempt === MAX_ATTEMPTS || signal?.aborted) throw error;
      console.warn(`llm: ${error.kind}, attempt ${attempt}/${MAX_ATTEMPTS}: ${error.detail.slice(0, 300)}`);
      const backoff = retryPolicy.baseMs * 2 ** attempt; // 2s, 4s, 8s
      await sleep(Math.min((error.retryAfterSeconds ?? 0) * 1000 || backoff, 30_000));
    }
  }
}

/** Reads the provider's event stream and yields text deltas. */
async function* readDeltas(response: Response): AsyncGenerator<string, undefined> {
  if (!response.body) throw busy("no response body");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
      // A line can be split across two network chunks, so keep the last piece.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, "");
        if (!line.trim().startsWith("data:") || data === "[DONE]" || !data) continue;
        let event: { error?: { code?: number; message?: string }; choices?: { delta?: { content?: string | null } }[] };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        // The status line is long gone, so a late failure arrives in the body.
        if (event.error) throw toLlmError(Number(event.error.code) || 503, new Headers(), JSON.stringify(event.error));
        const text = event.choices?.[0]?.delta?.content;
        if (text) yield text;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
