import { NOT_COVERED, QUOTE_REMOVED, UNVERIFIED_ANSWER } from "@/limits";
import { appearsIn, findQuote, MIN_QUOTE_LENGTH, type QuoteMatch } from "./verify";

/**
 * Stands between the model's stream and the reader.
 *
 * - Every quotation is held back until it is complete and has been checked. A
 *   real one is shown in the contract's own words; any other is replaced.
 * - Nothing is shown until one quote has been verified. If none ever is, the
 *   reader gets a fixed reply instead of the model's claims.
 */

// "<quote" is enough to open: whatever follows it, attributes included, stays
// held until "</quote>" arrives, so a tag that never finishes cannot leak text.
const OPENER = /<quote(?=[\s>])|["“]/i;
const TAG_CLOSER = /<\/quote\s*>/i;
const MARK_CLOSER = /["”]/;
const QUOTE_TAGS = /<\/?quote(?:\s[^>]*)?>/gi;

/** An elided quote resolves to the whole span it covers, which can be very long. */
const MAX_SHOWN_QUOTE = 1500;

export class AnswerGate {
  /** Verified quotes, in order, each once. */
  readonly quotes: QuoteMatch[] = [];
  /** How many quotes were left out. */
  removed = 0;

  private buffer = "";
  private held = "";
  private open = false;

  constructor(
    private readonly contractText: string,
    private readonly question: string,
  ) {}

  /** Takes a piece of the model's answer and returns what may be shown now. */
  push(piece: string): string {
    this.buffer += piece;
    let shown = "";
    for (;;) {
      const opener = OPENER.exec(this.buffer);
      if (!opener) return shown + this.release(this.takePlainText());

      const isTag = opener[0].startsWith("<");
      const afterOpener = opener.index + opener[0].length;
      const closing = (isTag ? TAG_CLOSER : MARK_CLOSER).exec(this.buffer.slice(afterOpener));
      const before = this.buffer.slice(0, opener.index);
      if (!closing) {
        this.buffer = this.buffer.slice(opener.index);
        return shown + this.release(before);
      }
      const quote = this.buffer.slice(afterOpener, afterOpener + closing.index);
      this.buffer = this.buffer.slice(afterOpener + closing.index + closing[0].length);
      shown += this.release(before) + this.release(this.check(quote, isTag));
    }
  }

  /** Call once when the model has finished. */
  end(): string {
    // push() leaves an unfinished quote at the start of the buffer. One that
    // never closed is checked like any other.
    const opener = OPENER.exec(this.buffer);
    const rest = opener
      ? this.check(this.buffer.slice(opener[0].length), opener[0].startsWith("<"))
      : this.buffer;
    this.buffer = "";
    const shown = this.release(rest);
    if (this.open) return shown;

    const said = this.held.toLowerCase();
    return said.includes(NOT_COVERED.toLowerCase().replace(/\.$/, "")) ? NOT_COVERED : UNVERIFIED_ANSWER;
  }

  /** Everything except the start of what may turn out to be a tag. */
  private takePlainText(): string {
    const at = this.buffer.lastIndexOf("<");
    const tail = at < 0 ? "" : this.buffer.slice(at).toLowerCase();
    const maybeTag = tail.length > 0 && ("<quote".startsWith(tail) || "</quote".startsWith(tail));
    const text = maybeTag ? this.buffer.slice(0, at) : this.buffer;
    this.buffer = maybeTag ? this.buffer.slice(at) : "";
    return text;
  }

  private check(raw: string, isTag: boolean): string {
    const inner = isTag ? raw.replace(/^[^>]*>/, "") : raw; // the rest of the opening tag
    const quote = inner.replace(QUOTE_TAGS, "").trim();
    if (!quote) return "";

    const match = findQuote(this.contractText, quote);
    if (match && match.text.length <= MAX_SHOWN_QUOTE) {
      this.open = true;
      if (!this.quotes.some((seen) => seen.start === match.start && seen.end === match.end)) this.quotes.push(match);
      return `“${match.text.replace(/\s+/g, " ")}”`;
    }
    // Too short to be evidence, but a term the contract or the question uses may
    // be mentioned. It does not open the gate.
    const mentioned =
      quote.length < MIN_QUOTE_LENGTH && (appearsIn(this.contractText, quote) || appearsIn(this.question, quote));
    if (mentioned) return `“${quote}”`;

    this.removed++;
    return QUOTE_REMOVED;
  }

  private release(text: string): string {
    const clean = text.replace(QUOTE_TAGS, "");
    if (this.open) {
      const shown = this.held + clean;
      this.held = "";
      return shown;
    }
    this.held = (this.held + clean).trimStart();
    return "";
  }
}
