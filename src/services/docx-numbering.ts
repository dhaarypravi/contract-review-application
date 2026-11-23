import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

/**
 * Word keeps automatic clause numbers ("7.1", "(a)") outside the text, and
 * mammoth drops them. DOCX has no fixed pages either, so without the numbers a
 * finding would have nothing to cite. This writes each number into its paragraph,
 * as Word displays it, before mammoth reads the file.
 */
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

interface Level {
  format: string;
  text: string;
  start: number;
}

type Node = ReturnType<DOMParser["parseFromString"]>["documentElement"];

const all = (root: Node | Document, name: string): Node[] =>
  Array.from((root as Node).getElementsByTagName(`w:${name}`) as unknown as ArrayLike<Node>);

const child = (parent: Node | undefined, name: string): Node | undefined => {
  for (let node = parent?.firstChild; node; node = node.nextSibling) {
    if (node.nodeName === `w:${name}`) return node as Node;
  }
  return undefined;
};

const val = (node: Node | undefined): string | undefined => node?.getAttribute("w:val") || undefined;

export class Numbering {
  private readonly abstracts = new Map<string, Map<number, Level>>();
  private readonly nums = new Map<string, { abstractId: string; startOverrides: Map<number, number> }>();
  private readonly styleNumbers = new Map<string, { numId?: string; level?: number; basedOn?: string }>();
  /** Lists built on the same definition share their counters, as in Word. */
  private readonly counters = new Map<string, number[]>();
  private readonly startedNums = new Set<string>();

  constructor(numberingXml: string, stylesXml?: string) {
    const numbering = new DOMParser().parseFromString(numberingXml, "text/xml").documentElement;
    for (const abstract of all(numbering, "abstractNum")) {
      const levels = new Map<number, Level>();
      for (const level of all(abstract, "lvl")) {
        levels.set(Number(level.getAttribute("w:ilvl")), {
          format: val(child(level, "numFmt")) ?? "decimal",
          text: child(level, "lvlText")?.getAttribute("w:val") ?? "",
          start: Number(val(child(level, "start")) ?? 1),
        });
      }
      this.abstracts.set(abstract.getAttribute("w:abstractNumId")!, levels);
    }
    for (const num of all(numbering, "num")) {
      const startOverrides = new Map<number, number>();
      for (const override of all(num, "lvlOverride")) {
        const start = val(child(override, "startOverride"));
        if (start !== undefined) startOverrides.set(Number(override.getAttribute("w:ilvl")), Number(start));
      }
      const abstractId = val(child(num, "abstractNumId"));
      if (abstractId !== undefined) this.nums.set(num.getAttribute("w:numId")!, { abstractId, startOverrides });
    }
    if (stylesXml) {
      const styles = new DOMParser().parseFromString(stylesXml, "text/xml").documentElement;
      for (const style of all(styles, "style")) {
        const numPr = child(child(style, "pPr"), "numPr");
        const level = val(child(numPr, "ilvl"));
        this.styleNumbers.set(style.getAttribute("w:styleId")!, {
          numId: val(child(numPr, "numId")),
          level: level === undefined ? undefined : Number(level),
          basedOn: val(child(style, "basedOn")),
        });
      }
    }
  }

  /** The number shown on a paragraph, advancing its list, or null. */
  labelFor(paragraph: Node): string | null {
    const properties = child(paragraph, "pPr");
    const direct = child(properties, "numPr");
    const inherited = this.fromStyle(val(child(properties, "pStyle")));
    const numId = val(child(direct, "numId")) ?? inherited.numId;
    if (!numId || numId === "0") return null; // 0 switches an inherited number off
    return this.next(numId, Number(val(child(direct, "ilvl")) ?? inherited.level ?? 0));
  }

  next(numId: string, level: number): string | null {
    const num = this.nums.get(numId);
    const levels = num && this.abstracts.get(num.abstractId);
    const definition = levels?.get(level);
    if (!num || !levels || !definition) return null;

    const counters = this.counters.get(num.abstractId) ?? [];
    this.counters.set(num.abstractId, counters);
    if (!this.startedNums.has(numId)) {
      this.startedNums.add(numId);
      for (const overridden of num.startOverrides.keys()) counters.length = Math.min(counters.length, overridden);
    }
    const startOf = (at: number) => num.startOverrides.get(at) ?? levels.get(at)?.start ?? 1;
    for (let at = 0; at < level; at++) counters[at] ??= startOf(at);
    counters[level] = counters[level] === undefined ? startOf(level) : counters[level] + 1;
    counters.length = level + 1; // deeper levels start again

    if (definition.format === "bullet" || definition.format === "none") return null;
    const label = definition.text
      .replace(/%(\d)/g, (_, digit: string) => {
        const at = Number(digit) - 1;
        return formatNumber(counters[at] ?? startOf(at), levels.get(at)?.format ?? "decimal");
      })
      .trim();
    return label || null;
  }

  private fromStyle(styleId: string | undefined): { numId?: string; level?: number } {
    let numId: string | undefined;
    let level: number | undefined;
    const seen = new Set<string>();
    for (let id = styleId; id && !seen.has(id); id = this.styleNumbers.get(id)?.basedOn) {
      seen.add(id);
      numId ??= this.styleNumbers.get(id)?.numId;
      level ??= this.styleNumbers.get(id)?.level;
    }
    return { numId, level };
  }
}

export function formatNumber(value: number, format: string): string {
  switch (format) {
    case "lowerLetter":
      return letters(value).toLowerCase();
    case "upperLetter":
      return letters(value);
    case "lowerRoman":
      return roman(value).toLowerCase();
    case "upperRoman":
      return roman(value);
    case "decimalZero":
      return String(value).padStart(2, "0");
    default:
      return String(value);
  }
}

/** A..Z, then AA, BB, as Word counts. */
const letters = (value: number) =>
  String.fromCharCode(65 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1);

function roman(value: number): string {
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let rest = value;
  let out = "";
  for (const [size, symbol] of table) {
    for (; rest >= size; rest -= size) out += symbol;
  }
  return out;
}

/** Returns the file with its numbers written in, or unchanged if it has none. */
export async function writeNumbersIntoText(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const numberingXml = await zip.file("word/numbering.xml")?.async("string");
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!numberingXml || !documentXml) return bytes;

  const numbering = new Numbering(numberingXml, await zip.file("word/styles.xml")?.async("string"));
  const document = new DOMParser().parseFromString(documentXml, "text/xml");
  for (const paragraph of all(document.documentElement, "p")) {
    const label = numbering.labelFor(paragraph);
    if (!label) continue;
    const run = document.createElementNS(WORD_NS, "w:r");
    const text = document.createElementNS(WORD_NS, "w:t");
    text.setAttribute("xml:space", "preserve");
    text.appendChild(document.createTextNode(`${label} `));
    run.appendChild(text);
    const properties = child(paragraph, "pPr");
    paragraph.insertBefore(run, properties ? properties.nextSibling : paragraph.firstChild);
  }
  zip.file("word/document.xml", new XMLSerializer().serializeToString(document));
  return zip.generateAsync({ type: "uint8array" });
}
