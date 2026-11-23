import { and, asc, desc, eq, getTableColumns } from "drizzle-orm";
import { chatMessages, chunks, contracts, db, findings, type Contract } from "@/db";
import { NotFoundError } from "@/lib/errors";

/**
 * Every read and delete of a contract and its children. Each query states its
 * own user_id predicate instead of inheriting one. The builders are exported so
 * that the isolation tests can assert on the SQL they generate.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const owned = (id: string, userId: string) => and(eq(contracts.id, id), eq(contracts.userId, userId));

// The list never loads the text of every contract.
const { fullText: _fullText, pageMap: _pageMap, ...listColumns } = getTableColumns(contracts);

export const listQuery = (userId: string) =>
  db.select(listColumns).from(contracts).where(eq(contracts.userId, userId)).orderBy(desc(contracts.createdAt));

export const ownedContractQuery = (id: string, userId: string) =>
  db.select().from(contracts).where(owned(id, userId)).limit(1);

export const findingsQuery = (contractId: string, userId: string) =>
  db
    .select()
    .from(findings)
    .where(and(eq(findings.contractId, contractId), eq(findings.userId, userId)));

export const chatQuery = (contractId: string, userId: string) =>
  db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.contractId, contractId), eq(chatMessages.userId, userId)))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.role));

export const chunkSpansQuery = (contractId: string, userId: string) =>
  db
    .select({
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
      sectionLabel: chunks.sectionLabel,
      ordinal: chunks.ordinal,
    })
    .from(chunks)
    .where(and(eq(chunks.contractId, contractId), eq(chunks.userId, userId)))
    .orderBy(asc(chunks.ordinal));

export const deleteQuery = (id: string, userId: string) =>
  db.delete(contracts).where(owned(id, userId)).returning({ storagePath: contracts.storagePath });

/** The only way to get a contract. It cannot be told not to filter by user. */
export async function loadOwnedContract(id: string, userId: string): Promise<Contract> {
  if (!UUID.test(id)) throw new NotFoundError();
  const [contract] = await ownedContractQuery(id, userId);
  if (!contract) throw new NotFoundError();
  return contract;
}

/** Deletes the row; chunks, findings and chat go with it. Returns the file's path. */
export async function deleteOwnedContract(id: string, userId: string): Promise<string> {
  if (!UUID.test(id)) throw new NotFoundError();
  const [deleted] = await deleteQuery(id, userId);
  if (!deleted) throw new NotFoundError();
  return deleted.storagePath;
}

export async function updateOwnedContract(id: string, userId: string, patch: Partial<typeof contracts.$inferInsert>) {
  await db
    .update(contracts)
    .set({ ...patch, updatedAt: new Date() })
    .where(owned(id, userId));
}

export interface ClauseView {
  sectionLabel: string | null;
  before: string;
  quote: string;
  after: string;
}

/** The whole clause around a verified quote, split so the quote can be highlighted. */
export function clauseAround(
  fullText: string,
  spans: { charStart: number; charEnd: number; sectionLabel: string | null }[],
  start: number,
  end: number,
): ClauseView {
  const first = spans.find((span) => start >= span.charStart && start < span.charEnd);
  // A long clause is stored in several overlapping pieces, so join its neighbours.
  const sameClause = spans.filter(
    (span) => first && span.sectionLabel !== null && span.sectionLabel === first.sectionLabel,
  );
  const pieces = first ? [first, ...sameClause] : [];
  const from = Math.min(start, ...pieces.map((span) => span.charStart));
  const to = Math.max(end, ...pieces.map((span) => span.charEnd));
  return {
    sectionLabel: first?.sectionLabel ?? null,
    before: fullText.slice(from, start),
    quote: fullText.slice(start, end),
    after: fullText.slice(end, to),
  };
}
