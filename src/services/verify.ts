/**
 * The guard everything else relies on: does this quote really appear in the
 * contract?
 *
 * Forgive everything that is not a word. Forgive nothing that is.
 *
 * Exact matching would reject genuine quotes, because PDF extraction and models
 * both disturb whitespace and punctuation shapes. Fuzzy matching would accept a
 * paraphrase, because any threshold loose enough for punctuation is loose enough
 * for a reworded sentence. So both sides are normalised, then matched exactly.
 */
export interface QuoteMatch {
  start: number;
  end: number;
  /** The contract's own characters, never the model's copy. */
  text: string;
}

export const MIN_QUOTE_LENGTH = 12;

const REPLACEMENTS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
};
const REMOVED = /[­​‌‍⁠﻿]/;

interface Normalised {
  text: string;
  /** map[i] is the index in the original of normalised character i. */
  map: number[];
}

function normalise(source: string): Normalised {
  let text = "";
  const map: number[] = [];
  let pendingSpace = -1;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (REMOVED.test(char)) continue;
    if (/\s/.test(char)) {
      if (pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0 && text) {
      text += " ";
      map.push(pendingSpace);
    }
    pendingSpace = -1;
    // Lowercasing can change length ("İ"), so map every resulting character.
    for (const out of (REPLACEMENTS[char] ?? char).toLowerCase()) {
      for (let unit = 0; unit < out.length; unit++) map.push(i);
      text += out;
    }
  }
  return { text, map };
}

// Chat checks several quotes against one contract; normalise it once.
let cached: { source: string; value: Normalised } | undefined;
function normaliseContract(source: string): Normalised {
  if (cached?.source !== source) cached = { source, value: normalise(source) };
  return cached.value;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** indexOf, but never inside a word: "able" must not match within "payable". */
function indexOfWords(haystack: string, needle: string, from: number): number {
  for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = isWordChar(haystack[at - 1]) && isWordChar(needle[0]);
    const after = isWordChar(haystack[at + needle.length]) && isWordChar(needle[needle.length - 1]);
    if (!before && !after) return at;
  }
  return -1;
}

/** Whether a term occurs, as whole words. For mentions, not for evidence. */
export function appearsIn(text: string, term: string): boolean {
  const needle = normalise(term).text;
  return needle.length > 0 && indexOfWords(normalise(text).text, needle, 0) >= 0;
}

/**
 * @param near the excerpt the model cited, so that a sentence appearing twice is
 *   located where the model said it was.
 */
export function findQuote(
  fullText: string,
  quote: string,
  near?: { start: number; end: number },
): QuoteMatch | null {
  const trimmed = quote.trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  const segments = trimmed
    .split(/\.{3,}|…/)
    .map((segment) => normalise(segment.replace(/\[\s*$|^\s*\]/g, "")).text)
    .filter((segment) => segment.length > 0);
  if (segments.reduce((total, segment) => total + segment.length, 0) < MIN_QUOTE_LENGTH) return null;

  const contract = normaliseContract(fullText);
  let preferredFrom = 0;
  if (near) {
    preferredFrom = contract.map.findIndex((original) => original >= near.start);
    if (preferredFrom < 0) preferredFrom = 0;
  }

  const attempt = (from: number) => {
    let cursor = from;
    let first = -1;
    for (const segment of segments) {
      const at = indexOfWords(contract.text, segment, cursor);
      if (at < 0) return null;
      if (first < 0) first = at;
      cursor = at + segment.length;
    }
    const start = contract.map[first]!;
    const end = contract.map[cursor - 1]! + 1;
    return { start, end, text: fullText.slice(start, end) };
  };

  const nearby = near ? attempt(preferredFrom) : null;
  if (nearby && near && nearby.start < near.end) return nearby;
  return attempt(0);
}
