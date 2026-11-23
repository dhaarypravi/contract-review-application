/**
 * The fixed review checklist. Each item has its own retrieval query, written to
 * read like the clause rather than like the label: embedding the words
 * "limitation of liability" does not find "neither party shall be liable for
 * indirect damages".
 */
export interface ChecklistItem {
  key: string;
  label: string;
  /** Embedded for semantic search. */
  query: string;
  /** Matched literally for lexical search. */
  keywords: string[];
  /** Words that suggest a chunk belongs to a neighbouring item. */
  negativeKeywords?: string[];
  /** Always include the opening of the contract, where the recitals are. */
  includeOpening?: boolean;
  /** What counts as an answer. Given to the model with the excerpts. */
  guidance: string;
}

export const CHECKLIST: readonly ChecklistItem[] = [
  {
    key: "parties",
    label: "Parties",
    query:
      "This Agreement is made by and between Acme Limited, a company incorporated in England (hereinafter " +
      "referred to as the Supplier), and Beta Inc., a Delaware corporation (the Customer).",
    keywords: ["by and between", "between", "hereinafter", "referred to as", "a company", "party", "parties"],
    includeOpening: true,
    guidance:
      "Name each party and its role. The parties are usually in an unheaded opening paragraph. If a name is " +
      'still a blank or a placeholder such as "[COMPANY]", answer "unclear".',
  },
  {
    key: "start_date_and_term",
    label: "Start date and term",
    query:
      "This Agreement commences on the Effective Date and continues in force for an initial term of twelve months.",
    keywords: ["effective date", "commence", "commencement", "initial term", "initial period", "continue in force", "term of"],
    negativeKeywords: ["terminate", "termination"],
    includeOpening: true,
    guidance:
      "Report when the agreement starts and how long it lasts. This item is about duration, not about how the " +
      "agreement is ended early. If the excerpts give only one of the two, it is still \"found\": report that one.",
  },
  {
    key: "payment_terms",
    label: "Payment terms",
    query:
      "The Customer shall pay the fees within thirty days of the date of invoice. Late payments bear interest.",
    keywords: ["fee", "fees", "invoice", "payment", "pay", "payable", "interest", "late"],
    guidance: "Report what is paid and when it is due. Mention late-payment interest if it is stated.",
  },
  {
    key: "termination",
    label: "Termination",
    query:
      "Either party may terminate this Agreement by giving the other party not less than thirty days' prior " +
      "written notice, or immediately if the other party commits a material breach.",
    keywords: ["terminate", "termination", "material breach", "written notice", "insolvent", "expiry"],
    guidance: "Report who can end the agreement, on what grounds and with what notice.",
  },
  {
    key: "limitation_of_liability",
    label: "Limitation of liability",
    query:
      "Neither party shall be liable for indirect, incidental or consequential damages, and total aggregate " +
      "liability shall not exceed the fees paid in the preceding twelve months.",
    keywords: [
      "liability",
      "aggregate liability",
      "shall not exceed",
      "consequential",
      "indirect",
      "loss of profits",
      "cap",
      "damages",
    ],
    guidance:
      "Report the cap if there is one, and what is excluded. A clause that only excludes indirect damages " +
      'without capping direct liability is still "found": say so. An indemnity or a warranty disclaimer on its ' +
      "own is not a limitation of liability.",
  },
  {
    key: "confidentiality",
    label: "Confidentiality",
    query:
      "Each party shall keep confidential all Confidential Information disclosed by the other party and shall " +
      "not disclose it to any third party.",
    keywords: ["confidential", "confidentiality", "disclose", "disclosure", "proprietary", "non-disclosure", "survive"],
    guidance:
      "Report the obligation to keep information confidential, and how long it lasts if an excerpt says so. The " +
      'two are usually separate sub-clauses: a clear obligation is "found" even when no duration is visible.',
  },
  {
    key: "governing_law",
    label: "Governing law",
    query: "This Agreement shall be governed by and construed in accordance with the laws of England and Wales.",
    keywords: ["governed by", "governing law", "laws of", "construed in accordance", "jurisdiction"],
    guidance:
      "Report which law governs the agreement. A clause that only chooses a court or an arbitration venue, " +
      'without naming a governing law, is "unclear".',
  },
  {
    key: "auto_renewal",
    label: "Auto-renewal",
    query:
      "Upon expiry of the initial term this Agreement shall automatically renew for successive periods of twelve " +
      "months unless either party gives notice of non-renewal.",
    keywords: ["renew", "renewal", "automatically", "successive", "extend", "non-renewal"],
    guidance:
      "Report whether the agreement renews by itself and how to stop it. This is often one sentence inside the " +
      'term clause. An express statement that it does not renew automatically is "found". A term that simply ' +
      'expires, with nothing said about renewal, is "not_found", not "unclear".',
  },
] as const;

export const CHECKLIST_KEYS = CHECKLIST.map((item) => item.key);
