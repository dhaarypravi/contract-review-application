import type { Excerpt } from "./retrieve";

/** "Section 7.1 (TERMINATION), page 3", using only what is really known. */
export function locationOf(
  sectionLabel: string | null,
  pageNumber: number | null,
): string | null {
  const section = sectionLabel && (/^\d/.test(sectionLabel) ? `Section ${sectionLabel}` : sectionLabel);
  return [section, pageNumber ? `page ${pageNumber}` : null].filter(Boolean).join(", ") || null;
}

/**
 * Excerpts are numbered so the model can cite them, and wrapped so that text
 * inside a contract cannot pose as instructions.
 */
export function renderExcerpts(excerpts: Excerpt[], hasRealPages: boolean): string {
  return excerpts
    .map((excerpt, index) => {
      const location = locationOf(excerpt.sectionLabel, hasRealPages ? excerpt.pageFrom : null);
      const content = excerpt.content.replace(/<(\/?)excerpt/gi, "<$1 excerpt");
      return `<excerpt number="${index + 1}"${location ? ` location="${location.replace(/"/g, "'")}"` : ""}>\n${content}\n</excerpt>`;
    })
    .join("\n\n");
}
