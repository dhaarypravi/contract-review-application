import type { ApiError, ChatFrame } from "./dto";

/** Browser-side helpers. The Clerk session cookie goes with same-origin requests. */

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<RequestError> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return new RequestError(
    response.status,
    body?.error?.message ??
      (response.status === 401 ? "Your session has ended. Please sign in again." : "Something went wrong. Please try again."),
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new RequestError(0, "Could not reach the server. Check your connection and try again.");
  }
  if (!response.ok) throw await failure(response);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** XMLHttpRequest, because fetch cannot report upload progress. */
export function uploadFile(path: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new RequestError(0, "The upload was interrupted. Please try again."));
    request.onload = async () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      reject(await failure(new Response(request.responseText, { status: request.status })));
    };
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

/** Parses newline-delimited JSON. A frame can be split across two network chunks. */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as ChatFrame;
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer) as ChatFrame;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function* ask(contractId: string, question: string, signal: AbortSignal): AsyncGenerator<ChatFrame> {
  const response = await fetch(`/api/contracts/${contractId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  yield* readFrames(response.body);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * PDF text keeps the page's own line wraps, which break sentences on a narrow
 * screen. Joins them for display, keeping paragraphs and list items apart. Only
 * whitespace changes.
 */
export function reflow(text: string): string {
  return text.replace(/([^\n])\n(?!\n|[ \t]*(?:\([a-z0-9]{1,4}\)|\d{1,2}[.)]|[•–-]\s))/gi, "$1 ");
}
