import type { Citation } from "@/services/chat";
import type { ClauseView } from "@/services/contracts";
import type { ContractStatus, FindingStatus } from "@/db/schema";

/** What the API returns. Types only, so the browser bundle can import them. */

export interface ContractSummary {
  id: string;
  filename: string;
  sizeBytes: number;
  status: ContractStatus;
  statusDetail: string | null;
  pageCount: number | null;
  hasRealPages: boolean | null;
  createdAt: string;
}

export interface FindingView {
  status: FindingStatus;
  summary: string;
  quote: string | null;
  location: string | null;
  clause: ClauseView | null;
}

export interface ChecklistRow {
  key: string;
  label: string;
  /** Null until this item has been checked. */
  finding: FindingView | null;
}

export interface ContractDetail extends ContractSummary {
  items: ChecklistRow[];
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: string;
}

/** One line of the chat stream. */
export type ChatFrame =
  | { type: "delta"; text: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "error"; kind: string; error: string }
  | { type: "done" };

export interface ApiError {
  error: { code: string; message: string };
}
