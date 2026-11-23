import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { chunks, contracts, db, type Contract } from "@/db";
import { NotFoundError } from "@/lib/errors";
import { chunkContract, embeddingText } from "./chunk";
import { findingsQuery, loadOwnedContract, updateOwnedContract } from "./contracts";
import { extract, ExtractionError, sniffKind } from "./extract";
import { embedBatch, LlmError } from "./llm";
import { reviewContract } from "./review";

const INSERT_BATCH = 100;

/**
 * The whole pipeline for one contract: extract, chunk, embed, review. Safe to run
 * again: finished steps are skipped, so a retry resumes where it stopped.
 *
 * Throws only when the job should be retried. Every other outcome is recorded on
 * the contract.
 */
export async function processContract(
  contractId: string,
  userId: string,
  { lastAttempt = true, pauseMs }: { lastAttempt?: boolean; pauseMs?: number } = {},
): Promise<void> {
  try {
    const contract = await loadOwnedContract(contractId, userId);
    if (contract.status !== "processing") return;
    await runPipeline(contract, lastAttempt, pauseMs);
  } catch (error) {
    if (await isGone(contractId, userId)) return; // deleted while being processed
    if (!lastAttempt && isRetryable(error)) {
      await updateOwnedContract(contractId, userId, {
        statusDetail: "The AI service is busy. This will be tried again shortly.",
      });
      throw error;
    }
    console.error(`contract ${contractId} failed:`, describe(error));
    await updateOwnedContract(contractId, userId, { status: "failed", statusDetail: userMessage(error) });
  }
}

async function runPipeline(loaded: Contract, lastAttempt: boolean, pauseMs?: number) {
  const contract = loaded.fullText ? loaded : await ingest(loaded);

  const failures = await reviewContract(
    {
      id: contract.id,
      userId: contract.userId,
      fullText: contract.fullText!,
      pageMap: contract.pageMap ?? [],
      hasRealPages: contract.hasRealPages ?? false,
    },
    { pauseMs },
  );

  if (failures.length) {
    const retryable = failures.find(({ error }) => isRetryable(error));
    if (retryable && !lastAttempt) throw retryable.error;
    const finished = await findingsQuery(contract.id, contract.userId);
    if (!finished.length) throw failures[0]!.error;
  }

  // Derived from the page map, not from status_detail, which may hold a retry note.
  const notes = [emptyPagesWarning(contract)];
  if (failures.length) {
    const names = failures.map(({ item }) => item.label.toLowerCase()).join(", ");
    notes.push(`Not checked: ${names}. ${userMessage(failures[0]!.error)}`);
  }
  await updateOwnedContract(contract.id, contract.userId, {
    status: "reviewed",
    statusDetail: notes.filter(Boolean).join(" ") || null,
  });
}

/** Extract, chunk and embed. Text and chunks are written together, or not at all. */
async function ingest(contract: Contract): Promise<Contract> {
  const bytes = await readFile(contract.storagePath);
  const kind = sniffKind(bytes);
  if (!kind) throw new ExtractionError("This file type is not supported.");

  const extracted = await extract(bytes, kind);
  const drafts = chunkContract(extracted.fullText, extracted.pages);
  const vectors = await embedBatch(drafts.map(embeddingText));
  const patch = {
    fullText: extracted.fullText,
    pageMap: extracted.pages,
    pageCount: extracted.pageCount,
    hasRealPages: extracted.hasRealPages,
  };
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(and(eq(chunks.contractId, contract.id), eq(chunks.userId, contract.userId)));
    for (let start = 0; start < drafts.length; start += INSERT_BATCH) {
      await tx.insert(chunks).values(
        drafts.slice(start, start + INSERT_BATCH).map((draft, offset) => ({
          ...draft,
          contractId: contract.id,
          userId: contract.userId,
          embedding: vectors[start + offset]!,
        })),
      );
    }
    await tx
      .update(contracts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(contracts.id, contract.id), eq(contracts.userId, contract.userId)));
  });
  return { ...contract, ...patch };
}

function emptyPagesWarning({ pageMap, hasRealPages }: Contract): string | null {
  const empty = hasRealPages ? (pageMap ?? []).filter((span) => span.start === span.end).map((span) => span.page) : [];
  if (!empty.length) return null;
  return `No readable text on page${empty.length > 1 ? "s" : ""} ${empty.join(", ")}, so nothing there was reviewed.`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ExtractionError) return false;
  if (error instanceof LlmError) return error.kind === "busy" || error.kind === "rate_limited";
  return true;
}

function userMessage(error: unknown): string {
  if (error instanceof ExtractionError || error instanceof LlmError) return error.message;
  return "Something went wrong while reviewing this contract. Please upload it again.";
}

function describe(error: unknown): string {
  if (error instanceof LlmError) return `${error.kind}: ${error.detail}`;
  if (error instanceof ExtractionError) return error.message; // expected, so no stack
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function isGone(contractId: string, userId: string): Promise<boolean> {
  try {
    await loadOwnedContract(contractId, userId);
    return false;
  } catch (error) {
    return error instanceof NotFoundError;
  }
}
