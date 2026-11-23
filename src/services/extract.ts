import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { writeNumbersIntoText } from "./docx-numbering";

/**
 * Turns a file into one string plus a page map. Every offset downstream (chunks,
 * quotes, highlights) refers to exactly this string.
 */
export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

export interface Extracted {
  fullText: string;
  pages: PageSpan[];
  pageCount: number;
  /** DOCX and TXT have no fixed pages; findings then cite sections instead. */
  hasRealPages: boolean;
}

/** The message is shown to the user. Never retried: the file will not change. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export type FileKind = "pdf" | "docx" | "txt";

export const MIME_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

const MIN_TEXT_LENGTH = 40;
/** About 400 pages. Beyond this one file could use up a free tier's whole day. */
const MAX_TEXT_LENGTH = 1_000_000;

/** Decides by content, not by extension: a renamed image is not a PDF. */
export function sniffKind(bytes: Uint8Array): FileKind | null {
  if (bytes.length === 0) return null;
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024));
  if (head.includes("%PDF-")) return "pdf";
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // ZIP entry names are stored uncompressed.
    const all = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    return all.includes("word/document.xml") ? "docx" : null;
  }
  if (hasUtf16Bom(bytes)) return "txt";
  return bytes.includes(0) ? null : looksLikeText(bytes) ? "txt" : null;
}

const hasUtf16Bom = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

/** Rejects binary formats that happen to contain no NUL byte. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) control++;
  return control / sample.length < 0.01;
}

export async function extract(bytes: Uint8Array, kind: FileKind): Promise<Extracted> {
  const result =
    kind === "pdf" ? await extractPdf(bytes) : kind === "docx" ? await extractDocx(bytes) : extractTxt(bytes);

  if (result.fullText.trim().length < MIN_TEXT_LENGTH) {
    throw new ExtractionError(
      kind === "pdf"
        ? "This PDF has no readable text. It is probably a scan, and scanned documents are not supported."
        : "This file has no readable text.",
    );
  }
  if (result.fullText.length > MAX_TEXT_LENGTH) {
    throw new ExtractionError("This document is too long to review (more than about 400 pages of text).");
  }
  return result;
}

function normaliseText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "") // Postgres text cannot hold NUL
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function singlePage(text: string): Extracted {
  const fullText = normaliseText(text);
  return {
    fullText,
    pages: [{ page: 1, start: 0, end: fullText.length }],
    pageCount: 1,
    hasRealPages: false,
  };
}

function extractTxt(bytes: Uint8Array): Extracted {
  if (hasUtf16Bom(bytes)) {
    return singlePage(new TextDecoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be").decode(bytes));
  }
  try {
    return singlePage(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return singlePage(new TextDecoder("windows-1252").decode(bytes));
  }
}

async function extractDocx(bytes: Uint8Array): Promise<Extracted> {
  const { default: mammoth } = await import("mammoth");
  try {
    const numbered = await writeNumbersIntoText(bytes);
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(numbered) });
    return singlePage(value);
  } catch {
    throw new ExtractionError("This Word document could not be read. It may be damaged or password-protected.");
  }
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js takes ownership of the buffer, so give it a copy.
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  let document;
  try {
    document = await task.promise;
  } catch (error) {
    if ((error as { name?: string }).name === "PasswordException") {
      throw new ExtractionError("This PDF is password-protected. Remove the password and upload it again.");
    }
    throw new ExtractionError("This PDF could not be read. It may be damaged.");
  }

  try {
    const pageLines: string[][] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pageLines.push(toLines(content.items.filter((item): item is TextItem => "str" in item)));
      page.cleanup();
    }
    return joinPages(dropRunningHeaders(pageLines));
  } finally {
    await task.destroy();
  }
}

/**
 * pdf.js returns positioned fragments, not lines. A change in the y coordinate
 * starts a new line. Without this a page collapses into one paragraph and every
 * clause boundary is lost.
 */
function toLines(items: TextItem[]): string[] {
  const lines: { text: string; y: number }[] = [];
  let lastEndX = 0;

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4] as number;
    const y = item.transform[5] as number;
    const size = Math.hypot(item.transform[2] as number, item.transform[3] as number) || item.height || 10;
    const line = lines.at(-1);

    if (!line || Math.abs(y - line.y) > 2) {
      lines.push({ text: item.str, y });
    } else {
      const gap = line.text && !line.text.endsWith(" ") && !item.str.startsWith(" ") && x - lastEndX > size * 0.15;
      line.text += (gap ? " " : "") + item.str;
    }
    lastEndX = x + item.width;
  }
  return withParagraphBreaks(lines.filter((line) => line.text.trim()));
}

/**
 * A gap well above the page's usual line spacing starts a new paragraph. Judged
 * against the page itself, so that double-spaced contracts are not broken up.
 */
function withParagraphBreaks(lines: { text: string; y: number }[]): string[] {
  const gaps = lines.slice(1).map((line, index) => lines[index]!.y - line.y);
  const usual = gaps.filter((gap) => gap > 0).sort((a, b) => a - b)[Math.floor(gaps.length / 4)] ?? 0;
  return lines.flatMap((line, index) => {
    const gap = index ? gaps[index - 1]! : 0;
    return usual > 0 && gap > usual * 1.3 ? ["", line.text.trim()] : [line.text.trim()];
  });
}

/**
 * Removes headers and footers: the outermost lines of a page that repeat, digits
 * aside, on most pages. Left in, a footer would sit in the middle of any sentence
 * that crosses a page break and make its quote unverifiable.
 */
export function dropRunningHeaders(pages: string[][]): string[][] {
  if (pages.length < 3) return pages;
  const key = (line: string) => line.replace(/\d+/g, "#").trim().toLowerCase();
  const counts = new Map<string, number>();
  const edges = pages.map((lines) => {
    const filled = lines.map((line, index) => ({ line, index })).filter((entry) => entry.line);
    return [...new Set([...filled.slice(0, 2), ...filled.slice(-2)])];
  });
  for (const edge of edges) {
    for (const value of new Set(edge.map((entry) => key(entry.line)))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return pages.map((lines, page) => {
    const drop = new Set(
      edges[page]!.filter((entry) => counts.get(key(entry.line))! > pages.length / 2).map((entry) => entry.index),
    );
    return lines.filter((_, index) => !drop.has(index));
  });
}

function joinPages(pageLines: string[][]): Extracted {
  let fullText = "";
  const pages: PageSpan[] = [];
  pageLines.forEach((lines, index) => {
    const text = normaliseText(lines.join("\n"));
    if (fullText && text) fullText += "\n";
    const start = fullText.length;
    fullText += text;
    pages.push({ page: index + 1, start, end: fullText.length });
  });
  return { fullText, pages, pageCount: pageLines.length, hasRealPages: true };
}

export function pageAt(pages: PageSpan[], offset: number): number | null {
  const span = pages.find((candidate) => offset >= candidate.start && offset < candidate.end);
  return span?.page ?? pages.findLast((candidate) => candidate.start <= offset)?.page ?? null;
}
