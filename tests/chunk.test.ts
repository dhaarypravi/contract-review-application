import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkContract } from "@/services/chunk";
import { formatNumber, Numbering } from "@/services/docx-numbering";
import { dropRunningHeaders, extract, pageAt, sniffKind } from "@/services/extract";
import { withinBudget } from "@/services/retrieve";
import { findQuote } from "@/services/verify";

const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url));
const whole = (text: string) => chunkContract(text, [{ page: 1, start: 0, end: text.length }]);

describe("chunkContract", () => {
  it.each(["services-agreement.txt", "mutual-nda.txt"])("offsets point at exactly the chunk's own text: %s", async (name) => {
    const { fullText, pages } = await extract(sample(name), "txt");
    const chunks = chunkContract(fullText, pages);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) expect(fullText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    // Nothing but whitespace falls between chunks.
    let covered = 0;
    for (const chunk of chunks) {
      expect(fullText.slice(covered, Math.max(covered, chunk.charStart)).trim()).toBe("");
      covered = Math.max(covered, chunk.charEnd);
    }
    expect(fullText.slice(covered).trim()).toBe("");
  });

  it("labels sub-clauses with their number and their parent's title", async () => {
    const { fullText, pages } = await extract(sample("services-agreement.txt"), "txt");
    const labels = chunkContract(fullText, pages).map((chunk) => chunk.sectionLabel);
    expect(labels).toContain("7.1 (TERMINATION)");
    expect(labels).toContain("8.3 (LIMITATION OF LIABILITY)");
    expect(labels).toContain("11.1 (GOVERNING LAW AND JURISDICTION)");
    expect(labels.filter((label) => label && label.split(" ").length > 9)).toEqual([]); // no sentence fragments
  });

  it("keeps a clause whole and folds a lone heading into it", () => {
    const text = "7. TERMINATION\n\n7.1 Either party may terminate on thirty days' written notice.\n\n8. NOTICES\n\n8.1 In writing.";
    const chunks = whole(text);
    expect(chunks[0]!.content).toBe("7. TERMINATION\n\n7.1 Either party may terminate on thirty days' written notice.");
    expect(chunks[0]!.sectionLabel).toBe("7.1 (TERMINATION)");
  });

  it("keeps an auto-renewal sentence with its term clause", () => {
    const text = "2. TERM\n\n2.1 The initial term is one year. It shall automatically renew for successive years.\n\n3. FEES\n\n3.1 Ten.";
    expect(whole(text)[0]!.content).toMatch(/initial term[\s\S]*automatically renew/);
  });

  it("does not treat a wrapped line that starts with a number as a heading", () => {
    const text = "1. NOTICE\n\nThe notice period is\n30 days from receipt, and interest is\n2.5 percent above base.\n\n2. LAW\n\nEnglish law.";
    expect(whole(text).map((chunk) => chunk.sectionLabel)).toEqual(["1 NOTICE", "2 LAW"]);
  });

  it("recognises ARTICLE, SCHEDULE and title-case headings", () => {
    const text = "ARTICLE IV - Payment\nFees are due.\n\nSchedule A: Services\nForecasts.\n\nThe terms in section 5 of this deed apply.";
    expect(whole(text).map((chunk) => chunk.sectionLabel)).toEqual(["Article IV Payment", "Schedule A Services"]);
  });

  it("splits a long section at sentence ends, overlapping, under one label", () => {
    const text = `5. CONFIDENTIALITY\n\n${"The recipient shall keep the information secret. ".repeat(120)}`.trim();
    const chunks = whole(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.content.length).toBeLessThanOrEqual(1800);
      expect(chunk.sectionLabel).toBe("5 CONFIDENTIALITY");
      expect(chunk.content.endsWith(".")).toBe(true);
      if (index) expect(chunk.charStart).toBeLessThan(chunks[index - 1]!.charEnd);
    }
  });

  it("handles text with no headings and no spaces", () => {
    const chunks = whole("x".repeat(5000));
    expect(chunks.map((chunk) => chunk.content.length).every((length) => length <= 1800)).toBe(true);
    expect(chunks.at(-1)!.charEnd).toBe(5000);
  });
});

describe("extraction", () => {
  it("decides the type from the content, not the name", () => {
    expect(sniffKind(Buffer.from("%PDF-1.7\n..."))).toBe("pdf");
    expect(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBeNull();
    expect(sniffKind(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from("xl/workbook.xml")]))).toBeNull();
    expect(sniffKind(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from("word/document.xml")]))).toBe("docx");
    expect(sniffKind(Buffer.from("Plain agreement"))).toBe("txt");
    expect(sniffKind(Buffer.alloc(0))).toBeNull();
  });

  it("decodes UTF-16 and Windows-1252 text", async () => {
    const line = "This Agreement is made between two parties on the date below.";
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")]);
    expect((await extract(utf16, "txt")).fullText).toBe(line);
    const legacy = Buffer.concat([Buffer.from([0x93]), Buffer.from(line), Buffer.from([0x94])]);
    expect((await extract(legacy, "txt")).fullText).toBe(`“${line}”`);
  });

  it("refuses a file with no readable text", async () => {
    await expect(extract(Buffer.from("   \n  "), "txt")).rejects.toThrow(/no readable text/);
  });

  it("drops running headers and footers but keeps repeated body text", () => {
    const page = (n: number, body: string) => ["Acme MSA", body, "Time is of the essence.", "More text.", "x", `Page ${n} of 3`];
    const cleaned = dropRunningHeaders([page(1, "One"), page(2, "Two"), page(3, "Three")]);
    expect(cleaned[1]!.join("|")).not.toMatch(/Acme|Page/);
    expect(cleaned.every((lines) => lines.includes("Time is of the essence."))).toBe(true);
  });

  it("maps an offset to its page", () => {
    const pages = [{ page: 1, start: 0, end: 10 }, { page: 2, start: 11, end: 20 }];
    expect([pageAt(pages, 0), pageAt(pages, 9), pageAt(pages, 11), pageAt(pages, 19)]).toEqual([1, 1, 2, 2]);
  });
});

describe("withinBudget", () => {
  const of = (...lengths: number[]) => lengths.map((length) => ({ content: "x".repeat(length) }));
  const budget = { min: 2, max: 5, maxChars: 100 };

  it("takes many short clauses, up to the maximum", () => expect(withinBudget(of(10, 10, 10, 10, 10, 10), budget)).toHaveLength(5));
  it("stops at the character budget", () => expect(withinBudget(of(40, 40, 40, 40), budget)).toHaveLength(2));
  it("always gives the minimum, however long", () => expect(withinBudget(of(900, 900, 900), budget)).toHaveLength(2));
  it("handles fewer than the minimum", () => expect(withinBudget(of(10), budget)).toHaveLength(1));
});

describe("Word numbering", () => {
  const level = (at: number, format: string, text: string, start = 1) =>
    `<w:lvl w:ilvl="${at}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = (levels: string, nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>') =>
    new Numbering(
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${levels}</w:abstractNum>${nums}</w:numbering>`,
    );

  it("numbers nested levels and starts deeper ones again", () => {
    const list = numbering(level(0, "decimal", "%1.") + level(1, "decimal", "%1.%2") + level(2, "lowerLetter", "(%3)"));
    const labels = [0, 1, 1, 2, 2, 0, 1, 2].map((at) => list.next("1", at));
    expect(labels).toEqual(["1.", "1.1", "1.2", "(a)", "(b)", "2.", "2.1", "(a)"]);
  });

  it("honours the start value and restarts an overridden list", () => {
    const list = numbering(
      level(0, "upperRoman", "Article %1", 4),
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>',
    );
    expect([list.next("1", 0), list.next("1", 0), list.next("2", 0), list.next("2", 0)]).toEqual([
      "Article IV", "Article V", "Article I", "Article II",
    ]);
  });

  it("gives bullets and unknown lists no number", () => {
    const list = numbering(level(0, "bullet", "\u2022"));
    expect([list.next("1", 0), list.next("9", 0)]).toEqual([null, null]);
  });

  it("formats numbers as Word does", () => {
    expect([formatNumber(27, "lowerLetter"), formatNumber(9, "lowerRoman"), formatNumber(3, "decimalZero")]).toEqual(["aa", "ix", "03"]);
  });

  it("makes an automatically numbered contract citable by section", async () => {
    const { fullText, pages, hasRealPages } = await extract(sample("consulting-agreement.docx"), "docx");
    expect(hasRealPages).toBe(false);
    expect(fullText).toContain("2.1 Either party may terminate");
    expect(fullText).toContain("(b) becomes insolvent.");
    const labels = chunkContract(fullText, pages).map((chunk) => chunk.sectionLabel);
    expect(labels).toEqual(expect.arrayContaining(["1.1 (Term)", "2.1 (Termination)", "3.1 (Governing Law)"]));
  });
});

describe("PDF", () => {
  it("keeps pages, drops the footer and finds the clauses", async () => {
    const { fullText, pages, pageCount, hasRealPages } = await extract(sample("services-agreement.pdf"), "pdf");
    expect([pageCount, hasRealPages]).toEqual([4, true]);
    expect(fullText).not.toMatch(/Page \d of/);
    const chunks = chunkContract(fullText, pages);
    for (const chunk of chunks) expect(fullText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    const liability = chunks.find((chunk) => chunk.sectionLabel === "8.3 (LIMITATION OF LIABILITY)")!;
    expect(liability.pageFrom).toBe(3);
    expect(liability.content).not.toMatch(/\n\n/); // double spacing is not a paragraph break
  });

  it("finds a quote that runs across a page break", async () => {
    const { fullText, pages } = await extract(sample("services-agreement.pdf"), "pdf");
    const straddling = pages.slice(1).map((page) => fullText.slice(page.start - 60, page.start + 60).replace(/\s+/g, " ").trim());
    for (const text of straddling) {
      const words = text.split(" ").slice(1, -1).join(" ");
      expect(findQuote(fullText, words), words).not.toBeNull();
    }
  });

  it("explains a damaged file", async () => {
    await expect(extract(Buffer.from("%PDF-1.7 nothing else"), "pdf")).rejects.toThrow(/could not be read/);
  });
});
