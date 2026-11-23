import { describe, expect, it } from "vitest";
import { NOT_COVERED, QUOTE_REMOVED, UNVERIFIED_ANSWER } from "@/limits";
import { AnswerGate } from "@/services/answer-gate";

const CONTRACT = `1. PARTIES
This Agreement (the "Agreement") is made by and between Acme Ltd and Beta Inc.

7. TERMINATION
7.1 Either party may terminate this Agreement on thirty (30) days’
written notice. Fees are Net 30.`;

/** Runs an answer in pieces of one size, returning everything that was shown. */
function run(answer: string, size: number, question = "Can it be ended?") {
  const gate = new AnswerGate(CONTRACT, question);
  const shown: string[] = [];
  for (let at = 0; at < answer.length; at += size) shown.push(gate.push(answer.slice(at, at + size)));
  shown.push(gate.end());
  return { text: shown.join(""), shown, quotes: gate.quotes.map((quote) => quote.text), removed: gate.removed };
}

/** The result must not depend on where the network happens to split the stream. */
function settle(answer: string, question?: string) {
  const whole = run(answer, answer.length || 1, question);
  for (const size of [1, 2, 3, 7, 20]) {
    const split = run(answer, size, question);
    expect({ text: split.text, quotes: split.quotes, removed: split.removed }, `pieces of ${size}`).toEqual({
      text: whole.text,
      quotes: whole.quotes,
      removed: whole.removed,
    });
  }
  return whole;
}

const REAL = "Either party may terminate this Agreement";
const FAKE = "Either party may terminate this Agreement without any notice";

describe("AnswerGate", () => {
  it("shows a verified quote in the contract's own words, then the explanation", () => {
    const { text, quotes } = settle(`<quote>either party may terminate this agreement on thirty (30) days' written notice</quote> So 30 days is enough.`);
    expect(text).toBe(
      "“Either party may terminate this Agreement on thirty (30) days’ written notice” So 30 days is enough.",
    );
    expect(quotes).toEqual(["Either party may terminate this Agreement on thirty (30) days’\nwritten notice"]);
  });

  it("shows nothing at all until a quote has been verified", () => {
    const gate = new AnswerGate(CONTRACT, "q");
    expect(gate.push("Yes, it can be ended: ")).toBe("");
    expect(gate.push("<quote>Either party may terminate this Agr")).toBe("");
    expect(gate.push("eement</quote>")).toBe(`Yes, it can be ended: “${REAL}”`);
    expect(gate.push(" More.")).toBe(" More."); // and streams freely afterwards
  });

  it("never shows any part of an invented quote", () => {
    const { shown, text, quotes, removed } = settle(`<quote>${REAL}</quote> Also <quote>The fee doubles every year</quote> applies.`);
    expect(text).toBe(`“${REAL}” Also ${QUOTE_REMOVED} applies.`);
    expect([quotes.length, removed]).toEqual([1, 1]);
    expect(shown.join("")).not.toMatch(/doubles/);
    expect(run(`<quote>${REAL}</quote> <quote>The fee doubles every year</quote>`, 1).shown.join("")).not.toMatch(/fee/);
  });

  it("rejects a quote with words added to real ones", () => {
    expect(settle(`<quote>${FAKE}</quote> So none.`).text).toBe(UNVERIFIED_ANSWER);
  });

  it("gives a fixed reply when nothing could be verified, not the model's claims", () => {
    for (const answer of ["Yes, thirty days is typical.", `<quote>${FAKE}</quote> Yes.`, "", "   ", `"${FAKE}"`]) {
      expect(settle(answer).text).toBe(UNVERIFIED_ANSWER);
    }
  });

  it("uses a later quote when the first one fails", () => {
    const { text } = settle(`<quote>${FAKE}</quote> or rather <quote>${REAL}</quote>.`);
    expect(text).toBe(`${QUOTE_REMOVED} or rather “${REAL}”.`);
  });

  it("passes on an honest not-covered answer, and drops anything added to it", () => {
    expect(settle(NOT_COVERED).text).toBe(NOT_COVERED);
    expect(settle(`${NOT_COVERED} Usually, though, insurance is required.`).text).toBe(NOT_COVERED);
  });

  it("checks plain and curly double quotes too", () => {
    expect(settle(`It says "${REAL}".`).text).toBe(`It says “${REAL}”.`);
    expect(settle(`It says “${REAL}”.`).text).toBe(`It says “${REAL}”.`);
    expect(settle(`<quote>${REAL}</quote> and "the fee doubles every year".`).text).toBe(
      `“${REAL}” and ${QUOTE_REMOVED}.`,
    );
  });

  it("keeps double quotes that are part of a tagged quote", () => {
    const { text, quotes } = settle('<quote>This Agreement (the "Agreement") is made by and between Acme Ltd</quote>');
    expect(text).toBe('“This Agreement (the "Agreement") is made by and between Acme Ltd”');
    expect(quotes).toHaveLength(1);
  });

  it("allows a short quoted term only if the contract or the question has it", () => {
    const lead = `<quote>${REAL}</quote> `;
    expect(settle(`${lead}Terms are "Net 30".`).text).toContain("“Net 30”");
    expect(settle(`${lead}Nothing on "VAT".`, "What about VAT?").text).toContain("“VAT”");
    expect(settle(`${lead}Terms are "Net 90".`).text).toContain(`Terms are ${QUOTE_REMOVED}.`);
  });

  it("does not let the question vouch for a long quote", () => {
    const planted = "The supplier owes one million";
    const { text } = settle(`Yes: "${planted}".`, `Does it say "${planted}"?`);
    expect(text).toBe(UNVERIFIED_ANSWER);
  });

  it("does not let a short term open the gate", () => {
    expect(settle('It says "Net 30".').text).toBe(UNVERIFIED_ANSWER);
  });

  it("treats a quote that never closes as one that failed, unless it is real", () => {
    expect(settle(`<quote>${REAL}</quote> and <quote>the fee dou`).text).toBe(`“${REAL}” and ${QUOTE_REMOVED}`);
    expect(settle(`<quote>${REAL}`).text).toBe(`“${REAL}”`);
  });

  it("leaves ordinary text alone", () => {
    const { text } = settle(`<quote>${REAL}</quote> It's the party's right if 3 < 5 <b> and a <q.`);
    expect(text).toBe(`“${REAL}” It's the party's right if 3 < 5 <b> and a <q.`);
  });

  it("accepts tags with attributes and any case", () => {
    expect(settle(`<QUOTE excerpt="2">${REAL}</Quote>.`).text).toBe(`“${REAL}”.`);
  });

  it("does not let an unfinished tag carry a quote past the check", () => {
    const fake = "The fee doubles every year and the customer waives all of its rights under this and any other agreement";
    for (const answer of [`<quote x="${fake}`, `<quote ${fake}`, `<quote x="${fake}" y="${fake}`, `"${fake}`, `<quote>${fake}`]) {
      expect(settle(answer).text, answer).toBe(UNVERIFIED_ANSWER);
      expect(settle(`<quote>${REAL}</quote> Also ${answer}`).text, answer).toBe(`“${REAL}” Also ${QUOTE_REMOVED}`);
    }
  });

  it("checks a tag inside quotation marks, and drops a stray closing tag", () => {
    expect(settle(`"<quote>${REAL}</quote>" is the rule.`).text).toBe(`“${REAL}” is the rule.`);
    expect(settle(`<quote>${REAL}</quote></quote> Yes.`).text).toBe(`“${REAL}” Yes.`);
  });

  it("lists a quote used twice once", () => {
    expect(settle(`<quote>${REAL}</quote> and again <quote>${REAL}</quote>`).quotes).toEqual([REAL]);
  });
});
