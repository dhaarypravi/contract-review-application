import { pageAt, type PageSpan } from "./extract";

/**
 * Splits on the contract's own clause headings, never on a fixed window. Cutting
 * every 1,000 characters separates "either party may terminate" from "on thirty
 * days written notice", and after that no retrieval can recover the clause.
 */
export interface ChunkDraft {
  ordinal: number;
  content: string;
  sectionLabel: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  charStart: number;
  charEnd: number;
}

const MAX_CHUNK = 1800;
const OVERLAP = 200;
const MIN_CHUNK = 120;

const NUMBERED = /^\s{0,8}(\d{1,2}(?:\.\d{1,2}){0,3})([.):]?)\s+(\S[^\n]*)$/;
const NAMED = /^\s{0,8}((?:ARTICLE|SECTION|CLAUSE|SCHEDULE|EXHIBIT|ANNEX|APPENDIX)\s+(?:[IVXLCDM]{1,6}|\d{1,3}(?:\.\d{1,2}){0,2}|[A-Z]))\b\s*[.:\-–—]?\s*(.{0,90})$/i;
const ALL_CAPS = /^\s{0,8}([A-Z][A-Z0-9 &\-'\/,.()]{3,60})$/;

interface Heading {
  /** Offset of the start of the heading line. */
  start: number;
  lineEnd: number;
  number: string | null;
  title: string | null;
  /** Nothing but the heading on this line, so the clause text follows it. */
  alone: boolean;
}

export function chunkContract(fullText: string, pages: PageSpan[]): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  for (const section of sections(fullText)) {
    for (const [from, to] of splitLong(fullText, section.start, section.end)) {
      const [start, end] = trimSpan(fullText, from, to);
      if (start >= end) continue;
      chunks.push({
        ordinal: chunks.length,
        content: fullText.slice(start, end),
        sectionLabel: section.label,
        pageFrom: pageAt(pages, start),
        pageTo: pageAt(pages, end - 1),
        charStart: start,
        charEnd: end,
      });
    }
  }
  return chunks;
}

/** What is embedded: the label gives a short sub-clause its context. */
export function embeddingText(chunk: Pick<ChunkDraft, "content" | "sectionLabel">): string {
  return chunk.sectionLabel ? `${chunk.sectionLabel}\n${chunk.content}` : chunk.content;
}

function sections(text: string): { start: number; end: number; label: string | null }[] {
  const headings = findHeadings(text);
  const result: { start: number; end: number; label: string | null }[] = [];
  if (!headings.length || headings[0]!.start > 0) {
    result.push({ start: 0, end: headings[0]?.start ?? text.length, label: null });
  }

  let parent: Heading | null = null; // the last top-level heading with a title
  let carryFrom: number | null = null; // a lone heading, folded into what follows

  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? text.length;
    const start = carryFrom ?? heading.start;
    carryFrom = null;
    const isChild = heading.number !== null && heading.number.includes(".");
    if (!isChild) parent = heading;

    const bodyLength = text.slice(heading.lineEnd, end).trim().length;
    const isLone = heading.alone && bodyLength === 0 && end - start < MIN_CHUNK;
    if (isLone && index < headings.length - 1) {
      carryFrom = start;
      return;
    }
    result.push({ start, end, label: labelFor(heading, isChild ? parent : null) });
  });

  return result.filter((section) => text.slice(section.start, section.end).trim());
}

function labelFor(heading: Heading, parent: Heading | null): string | null {
  const own = [heading.number, heading.title].filter(Boolean).join(" ");
  // A sub-clause without its own title borrows its parent's: "7.1 (TERMINATION)".
  if (!heading.title && parent?.title && heading.number) return `${heading.number} (${parent.title})`;
  return own || null;
}

function findHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  let lastTop = 0;
  let offset = 0;

  for (const line of text.split("\n")) {
    const start = offset;
    const lineEnd = start + line.length;
    offset = lineEnd + 1;

    const named = NAMED.exec(line);
    if (named && isHeadingWord(named[1]!)) {
      const title = titleOf(named[2] ?? "");
      if (title || !named[2]?.trim()) {
        headings.push({ start, lineEnd, number: titleCase(named[1]!), title, alone: true });
        lastTop = 0; // schedules restart their numbering
        continue;
      }
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      const [, number, punctuation, rest] = numbered as unknown as [string, string, string, string];
      const title = titleOf(rest);
      if (isPlausibleNumber(number, punctuation, rest, title, lastTop)) {
        lastTop = Number(number.split(".")[0]);
        headings.push({ start, lineEnd, number, title, alone: title !== null });
        continue;
      }
    }

    const caps = ALL_CAPS.exec(line);
    if (caps && /[A-Z]{3}/.test(caps[1]!) && !/[.,]$/.test(caps[1]!.trim())) {
      headings.push({ start, lineEnd, number: null, title: caps[1]!.trim(), alone: true });
    }
  }
  return headings;
}

/** "SECTION 5" is a heading; "section 5 of this Agreement" is a sentence. */
const isHeadingWord = (label: string) => /^[A-Z]/.test(label);

/**
 * A wrapped line can start with a number ("30 days' prior written notice"), and
 * treating that as a heading would cut a clause in half. So the number has to
 * follow on from the clauses before it and what comes after has to start like one.
 */
function isPlausibleNumber(number: string, punctuation: string, rest: string, title: string | null, lastTop: number) {
  const parts = number.split(".").map(Number);
  const top = parts[0]!;
  // "7. TERMINATION" is strong enough evidence to skip ahead; anything weaker is not.
  const strong = parts.length === 1 && punctuation !== "" && title !== null;
  if (top < lastTop || (!strong && top > lastTop + 2)) return false;
  if (!/^["'“‘(\[]?\p{Lu}/u.test(rest)) return false;
  if (parts.length > 1) return true;
  if (top === lastTop) return false;
  return punctuation !== "" || title !== null;
}

/**
 * "7. TERMINATION" has a title; "7.1 Either party may terminate by..." runs into
 * prose. Keeping the trailing text in both cases would produce labels that are
 * sentence fragments, so it has to read like a title.
 */
function titleOf(rest: string): string | null {
  const text = rest.trim().replace(/:$/, "");
  if (!text || /[.,;:]$/.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length > 6) return null;
  return /^["'“(]?\p{Lu}/u.test(text) ? text : null;
}

const titleCase = (label: string) => label.replace(/^[A-Za-z]+/, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());

/** Splits an over-long section on paragraph, then sentence, then space. */
function splitLong(text: string, start: number, end: number): [number, number][] {
  const spans: [number, number][] = [];
  let from = start;
  while (end - from > MAX_CHUNK) {
    const cut = cutPoint(text, from, from + MAX_CHUNK);
    spans.push([from, cut]);
    from = overlapStart(text, from, cut);
  }
  spans.push([from, end]);
  return spans;
}

function cutPoint(text: string, from: number, limit: number): number {
  const window = text.slice(from, limit);
  const minimum = Math.floor(window.length / 2);
  for (const pattern of [/\n\s*\n/g, /\n(?=\s*\([a-z]{1,4}\)\s)/g, /[.;]["')”]?\s+/g, /\s+/g]) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const at = match.index + match[0].length;
      if (at >= minimum) best = at;
    }
    if (best > 0) return from + best;
  }
  return limit;
}

/** Steps back OVERLAP characters, to the start of a word, and always advances. */
function overlapStart(text: string, from: number, cut: number): number {
  let at = Math.max(cut - OVERLAP, from + 1);
  while (at < cut && !/\s/.test(text[at - 1]!)) at++;
  return at;
}

function trimSpan(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return [start, end];
}
