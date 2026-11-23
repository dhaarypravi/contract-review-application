import { NextResponse } from "next/server";
import { z } from "zod";
import { loadOwnedContract, requireUserId } from "@/lib/auth";
import type { ChatFrame } from "@/lib/dto";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { MAX_QUESTION_LENGTH } from "@/limits";
import { AnswerGate } from "@/services/answer-gate";
import { answerQuestion, buildCitations, saveMessage } from "@/services/chat";
import { chatQuery } from "@/services/contracts";
import { LlmError } from "@/services/llm";
import { messageOf } from "@/services/views";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH) });

export async function GET(_request: Request, { params }: Context) {
  try {
    const userId = await requireUserId();
    const contract = await loadOwnedContract((await params).id, userId);
    const messages = await chatQuery(contract.id, userId);
    return NextResponse.json({ messages: messages.map(messageOf) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Streams newline-delimited JSON frames. Text, citations and a late error share
 * one connection, and an error after the first byte cannot be a status code.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const userId = await requireUserId();
    const contract = await loadOwnedContract((await params).id, userId);
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ValidationError("invalid_question", `Ask a question of 1 to ${MAX_QUESTION_LENGTH} characters.`);
    }
    if (contract.status !== "reviewed") {
      throw new ValidationError("not_reviewed", "You can ask questions once the review has finished.", 409);
    }

    const { question } = body.data;
    const history = await chatQuery(contract.id, userId);
    await saveMessage(contract, "user", question);

    const aborter = new AbortController();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: ChatFrame) => {
          if (!aborter.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        };
        const gate = new AnswerGate(contract.fullText ?? "", question);
        let answer = ""; // only what passed the gate
        try {
          for await (const text of answerQuestion(contract, question, history, gate, aborter.signal)) {
            answer += text;
            send({ type: "delta", text });
          }
          const citations = await buildCitations(contract, gate.quotes);
          await saveMessage(contract, "assistant", answer.trim(), citations);
          send({ type: "citations", citations });
        } catch (error) {
          // Keep what the user already read.
          if (answer.trim()) {
            const citations = await buildCitations(contract, gate.quotes).catch(() => []);
            await saveMessage(contract, "assistant", `${answer.trim()}\n\n[This answer was interrupted.]`, citations).catch(
              () => {}, // the contract may have been deleted meanwhile
            );
          }
          if (!aborter.signal.aborted) {
            const known = error instanceof LlmError ? error : null;
            console.error("chat:", known ? `${known.kind}: ${known.detail}` : error);
            send({
              type: "error",
              kind: known?.kind ?? "internal",
              error: known?.message ?? "The answer could not be completed. Please try again.",
            });
          }
        } finally {
          send({ type: "done" });
          if (!aborter.signal.aborted) controller.close();
        }
      },
      cancel() {
        aborter.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
