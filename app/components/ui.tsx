import type { ReactNode } from "react";
import { reflow } from "@/lib/client";
import type { ClauseView } from "@/services/contracts";

const STYLES = {
  found: "bg-found-bg text-found",
  reviewed: "bg-found-bg text-found",
  not_found: "bg-missing-bg text-missing",
  unclear: "bg-unclear-bg text-unclear",
  processing: "bg-unclear-bg text-unclear",
  failed: "bg-danger-bg text-danger",
  pending: "bg-missing-bg text-missing",
} as const;

export type BadgeKind = keyof typeof STYLES;

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STYLES[kind]}`}>
      {children}
    </span>
  );
}

export function Notice({ tone, children }: { tone: "error" | "warning"; children: ReactNode }) {
  const style = tone === "error" ? "bg-danger-bg text-danger" : "bg-unclear-bg text-unclear";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md px-4 py-3 text-sm ${style}`}>
      {children}
    </div>
  );
}

/** The whole clause, with the verified quote highlighted inside it. */
export function Clause({ clause, wrapped }: { clause: ClauseView; wrapped: boolean }) {
  const show = wrapped ? reflow : (text: string) => text;
  return (
    <div className="contract-text max-h-96 overflow-y-auto rounded-md border border-line bg-paper p-4 text-sm leading-relaxed">
      {show(clause.before)}
      <mark>{show(clause.quote)}</mark>
      {show(clause.after)}
    </div>
  );
}
