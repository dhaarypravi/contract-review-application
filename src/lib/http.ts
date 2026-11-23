import { NextResponse } from "next/server";
import { LlmError } from "@/services/llm";
import { AppError } from "./errors";

const json = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status });

/** Maps a typed error to a status. Anything else is logged and stays private. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) return json(error.status, error.code, error.message);
  if (error instanceof LlmError) {
    const limited = error.kind === "rate_limited" || error.kind === "daily_limit";
    return json(limited ? 429 : 503, error.kind, error.message);
  }
  console.error("unhandled:", error);
  return json(500, "internal", "Something went wrong. Please try again.");
}
