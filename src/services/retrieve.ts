import { and, asc, cosineDistance, eq, or, sql } from "drizzle-orm";
import type { ChecklistItem } from "@/checklist";
import { chunks, db } from "@/db";

/**
 * Hybrid search inside one contract. Vector search misses clauses with unusual
 * wording; keyword search misses clauses that never use the checklist's words.
 * The lexical weight is there to rescue clauses the embedding ranks low, not to
 * drive the ranking: a chunk that says "payment" ten times should not outrank the
 * clause that states when payment is due.
 */
const SEMANTIC_WEIGHT = 0.65;
const LEXICAL_WEIGHT = 0.35;
const NEGATIVE_PENALTY = 0.05;
const CANDIDATES = 20;

export interface Excerpt {
  id: string;
  ordinal: number;
  content: string;
  sectionLabel: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  charStart: number;
  charEnd: number;
}

export interface SearchTerms {
  keywords: string[];
  negativeKeywords?: string[];
  includeOpening?: boolean;
}

/**
 * How much of the contract the model is shown. A fixed count is not enough: six
 * whole sections are plenty, but six one-sentence sub-clauses are a paragraph, and
 * a clause's exceptions or survival period would be left out.
 */
export interface Budget {
  min: number;
  max: number;
  maxChars: number;
}
export const ITEM_BUDGET: Budget = { min: 6, max: 14, maxChars: 6000 };
export const QUESTION_BUDGET: Budget = { min: 8, max: 16, maxChars: 8000 };

export function withinBudget<T extends { content: string }>(ranked: T[], budget: Budget): T[] {
  const taken: T[] = [];
  let chars = 0;
  for (const excerpt of ranked.slice(0, budget.max)) {
    chars += excerpt.content.length;
    if (taken.length >= budget.min && chars > budget.maxChars) break;
    taken.push(excerpt);
  }
  return taken;
}

const excerptColumns = {
  id: chunks.id,
  ordinal: chunks.ordinal,
  content: chunks.content,
  sectionLabel: chunks.sectionLabel,
  pageFrom: chunks.pageFrom,
  pageTo: chunks.pageTo,
  charStart: chunks.charStart,
  charEnd: chunks.charEnd,
};

/**
 * Both predicates, always. The user one is not needed for correctness, because
 * the contract was already loaded for this user; it is there to catch a mistake
 * somewhere else.
 */
const inContract = (contractId: string, userId: string) =>
  and(eq(chunks.contractId, contractId), eq(chunks.userId, userId));

export function semanticQuery(contractId: string, userId: string, vector: number[], limit = CANDIDATES) {
  const distance = cosineDistance(chunks.embedding, vector);
  return db
    .select({ ...excerptColumns, similarity: sql<number>`1 - (${distance})` })
    .from(chunks)
    .where(inContract(contractId, userId))
    .orderBy(distance)
    .limit(limit);
}

export function lexicalQuery(
  contractId: string,
  userId: string,
  vector: number[],
  keywords: string[],
  limit = CANDIDATES,
) {
  const distance = cosineDistance(chunks.embedding, vector);
  const matches = keywords.map((keyword) => sql`${chunks.content} ~* ${phrasePattern(keyword)}`);
  return db
    .select({ ...excerptColumns, similarity: sql<number>`1 - (${distance})` })
    .from(chunks)
    .where(and(inContract(contractId, userId), or(...matches)))
    .orderBy(distance)
    .limit(limit);
}

export function openingQuery(contractId: string, userId: string) {
  return db
    .select(excerptColumns)
    .from(chunks)
    .where(inContract(contractId, userId))
    .orderBy(asc(chunks.ordinal))
    .limit(1);
}

/**
 * A phrase as a pattern that also matches where it wraps onto the next line. PDF
 * text keeps its line breaks, so "shall not exceed" is often "shall not\nexceed".
 */
export function phrasePattern(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

/** How many of the keywords are present, matched from the start of a word. */
function keywordHits(content: string, keywords: string[]): number {
  return keywords.filter((keyword) => new RegExp(`\\b${phrasePattern(keyword)}`, "i").test(content)).length;
}

export function score(similarity: number, content: string, terms: SearchTerms): number {
  const lexical = terms.keywords.length ? keywordHits(content, terms.keywords) / terms.keywords.length : 0;
  const negatives = keywordHits(content, terms.negativeKeywords ?? []);
  return SEMANTIC_WEIGHT * similarity + LEXICAL_WEIGHT * lexical - NEGATIVE_PENALTY * negatives;
}

export async function retrieve(
  contractId: string,
  userId: string,
  vector: number[],
  terms: SearchTerms,
  budget: Budget,
): Promise<Excerpt[]> {
  const [semantic, lexical, opening] = await Promise.all([
    semanticQuery(contractId, userId, vector),
    terms.keywords.length ? lexicalQuery(contractId, userId, vector, terms.keywords) : [],
    terms.includeOpening ? openingQuery(contractId, userId) : [],
  ]);

  const candidates = new Map([...semantic, ...lexical].map((row) => [row.id, row]));
  const ranked = [...candidates.values()]
    .map((row) => ({ row, score: score(Number(row.similarity), row.content, terms) }))
    .sort((a, b) => b.score - a.score)
    .map(({ row: { similarity: _similarity, ...excerpt } }): Excerpt => excerpt);

  const seen = new Set(opening.map((row) => row.id));
  return withinBudget([...opening, ...ranked.filter((row) => !seen.has(row.id))], budget);
}

export function retrieveForItem(contractId: string, userId: string, vector: number[], item: ChecklistItem) {
  return retrieve(contractId, userId, vector, item, ITEM_BUDGET);
}

const STOP_WORDS = new Set(
  "about after also been before between could does from have here into many more much must only other over shall should that their them then there these they this those under what when where which while will with would your contract agreement clause".split(
    " ",
  ),
);

export function questionKeywords(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return [...new Set(words)].filter((word) => !STOP_WORDS.has(word)).slice(0, 10);
}
