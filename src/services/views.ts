import { CHECKLIST } from "@/checklist";
import type { ChatMessage, Contract } from "@/db";
import type { ContractDetail, ContractSummary, MessageView } from "@/lib/dto";
import { chunkSpansQuery, clauseAround, findingsQuery } from "./contracts";
import { locationOf } from "./prompt";

/** Rows to API shapes. Storage paths and user ids never leave the server. */

export function summaryOf(contract: Omit<Contract, "fullText" | "pageMap">): ContractSummary {
  return {
    id: contract.id,
    filename: contract.filename,
    sizeBytes: contract.sizeBytes,
    status: contract.status,
    statusDetail: contract.statusDetail,
    pageCount: contract.pageCount,
    hasRealPages: contract.hasRealPages,
    createdAt: contract.createdAt.toISOString(),
  };
}

/** Always all eight items, so the page does not reorder while a review runs. */
export async function detailOf(contract: Contract): Promise<ContractDetail> {
  const [rows, spans] = await Promise.all([
    findingsQuery(contract.id, contract.userId),
    chunkSpansQuery(contract.id, contract.userId),
  ]);
  const byKey = new Map(rows.map((row) => [row.itemKey, row]));

  return {
    ...summaryOf(contract),
    items: CHECKLIST.map(({ key, label }) => {
      const row = byKey.get(key);
      if (!row) return { key, label, finding: null };
      const hasQuote = row.quoteVerified && row.quoteCharStart !== null && row.quoteCharEnd !== null;
      return {
        key,
        label,
        finding: {
          status: row.status,
          summary: row.summary,
          quote: hasQuote ? row.quote : null,
          location: hasQuote ? locationOf(row.sectionLabel, row.pageNumber) : null,
          clause: hasQuote
            ? clauseAround(contract.fullText ?? "", spans, row.quoteCharStart!, row.quoteCharEnd!)
            : null,
        },
      };
    }),
  };
}

export function messageOf(message: ChatMessage): MessageView {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations,
    createdAt: message.createdAt.toISOString(),
  };
}
