import { describe, expect, it } from "vitest";
import { findQuote } from "@/services/verify";

const CONTRACT = `7. TERMINATION

7.1 Either party may terminate this Agreement by giving the other party not less than
thirty (30) days’ prior written notice.

8. LIABILITY

8.1 Neither party shall be liable for indirect loss. Each party’s total liability shall not exceed £50,000 – in aggregate.

9. NOTICES

9.1 Amounts are payable on demand. Notices must be in writing.

10. COPIES

10.1 Notices must be in writing.`;

const accept = (quote: string) => {
  const match = findQuote(CONTRACT, quote);
  expect(match, quote).not.toBeNull();
  expect(CONTRACT.slice(match!.start, match!.end)).toBe(match!.text);
  return match!;
};
const reject = (quote: string) => expect(findQuote(CONTRACT, quote), quote).toBeNull();

describe("accepts what is not a difference in words", () => {
  it("flattened line breaks, returning the contract's own characters", () => {
    const match = accept("not less than thirty (30) days’ prior written notice");
    expect(match.text).toBe("not less than\nthirty (30) days’ prior written notice");
  });
  it("straight quotes for curly ones", () => void accept("thirty (30) days' prior written notice"));
  it("a hyphen for a dash, and a no-break space", () => void accept("shall not exceed £50,000 - in aggregate"));
  it("case and repeated whitespace", () => void accept("EITHER  PARTY may   Terminate this agreement"));
  it("zero-width and soft-hyphen characters", () => void accept("may termi­nate​ this Agreement"));
  it("a wrapping pair of quotation marks", () => void accept('"Either party may terminate this Agreement"'));
  it("an ellipsis when the segments are in order", () => {
    const match = accept("Neither party shall be liable ... shall not exceed");
    expect(match.text).toMatch(/^Neither party[\s\S]*shall not exceed$/);
  });
});

describe("rejects what is", () => {
  it("a paraphrase", () => reject("Either party can end this agreement with 30 days notice"));
  it("one changed word", () => reject("Either party must terminate this Agreement"));
  it("one changed figure", () => reject("thirty (60) days' prior written notice"));
  it("ellipsis segments out of order", () => reject("shall not exceed ... Neither party shall be liable"));
  it("a fragment under 12 characters", () => reject("in writing."));
  it("a match that starts or ends inside a word", () => {
    reject("able on demand. Notices must");
    reject("Amounts are payable on dem");
  });
  it("an empty quote", () => reject("   "));
});

describe("locates repeated wording", () => {
  it("prefers the excerpt the model cited", () => {
    const second = CONTRACT.indexOf("10.1");
    const match = findQuote(CONTRACT, "Notices must be in writing", { start: second, end: CONTRACT.length });
    expect(match!.start).toBeGreaterThan(second);
    expect(findQuote(CONTRACT, "Notices must be in writing")!.start).toBeLessThan(second);
  });
  it("falls back to the whole contract when the citation is wrong", () => {
    expect(findQuote(CONTRACT, "Either party may terminate", { start: 400, end: 500 })).not.toBeNull();
  });
  it("maps ligatures and characters that change length when lowercased", () => {
    const text = "İlk the ﬁnal and binding oﬀer of terms";
    const match = findQuote(text, "the final and binding offer of terms")!;
    expect(match.text).toBe("the ﬁnal and binding oﬀer of terms");
  });
});
