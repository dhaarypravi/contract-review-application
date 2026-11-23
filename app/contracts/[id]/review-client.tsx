"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, formatDate, formatSize, RequestError } from "@/lib/client";
import type { ChecklistRow, ContractDetail, ContractSummary } from "@/lib/dto";
import { Badge, Clause, Notice } from "../../components/ui";
import { ChatPanel } from "./chat-panel";

const POLL_MS = 2000;
const STATUS_LABELS = { found: "Found", not_found: "Not found", unclear: "Unclear" } as const;

export function ReviewClient({ id }: { id: string }) {
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ contract: ContractDetail }>(`/api/contracts/${id}`);
      setContract(body.contract);
      setError(null);
    } catch (caught) {
      setError({
        message: caught instanceof Error ? caught.message : "Something went wrong.",
        missing: caught instanceof RequestError && caught.status === 404,
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const processing = contract?.status === "processing";
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [processing, load]);

  if (error?.missing) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-2xl font-semibold">Contract not found</h1>
        <p className="mt-2 text-muted">It may have been deleted, or it belongs to another account.</p>
        <Link href="/contracts" className="mt-4 inline-block text-accent underline">
          Back to my contracts
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/contracts" className="text-sm text-muted hover:underline">
        ← My contracts
      </Link>

      {error && (
        <Notice tone="error">
          {error.message}{" "}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}

      {!contract && !error && (
        <div aria-busy="true" aria-label="Loading review" className="space-y-3">
          <div className="h-10 w-1/2 animate-pulse rounded bg-missing-bg" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="h-24 animate-pulse rounded-lg bg-missing-bg" />
          ))}
        </div>
      )}

      {contract && (
        <>
          <Header contract={contract} />
          <div className="grid items-start gap-8 lg:grid-cols-[3fr_2fr]">
            <section aria-label="Checklist" className="space-y-3">
              {contract.items.map((row) => (
                <FindingCard key={row.key} row={row} contract={contract} />
              ))}
            </section>
            <ChatPanel contractId={id} ready={contract.status === "reviewed"} status={contract.status} />
          </div>
        </>
      )}
    </div>
  );
}

function Header({ contract }: { contract: ContractDetail }) {
  const found = contract.items.filter((row) => row.finding?.status === "found").length;
  const checked = contract.items.filter((row) => row.finding).length;
  const pages = contract.hasRealPages
    ? `${contract.pageCount} page${contract.pageCount === 1 ? "" : "s"}`
    : contract.hasRealPages === false
      ? "This format has no fixed pages, so clauses are cited by section"
      : null;

  return (
    <header>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">{contract.filename}</h1>
        <Badge kind={contract.status}>
          {contract.status === "processing"
            ? `Processing, ${checked} of ${contract.items.length} checked`
            : contract.status === "reviewed"
              ? `Reviewed, ${found} of ${contract.items.length} found`
              : "Failed"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        {[formatSize(contract.sizeBytes), formatDate(contract.createdAt), pages].filter(Boolean).join(" · ")}
      </p>
      {contract.statusDetail && (
        <div className="mt-4">
          <Notice tone={contract.status === "failed" ? "error" : "warning"}>{contract.statusDetail}</Notice>
        </div>
      )}
    </header>
  );
}

function FindingCard({ row, contract }: { row: ChecklistRow; contract: ContractSummary }) {
  const [open, setOpen] = useState(false);
  const { finding } = row;

  return (
    <article className="rounded-lg border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-medium">{row.label}</h2>
        {finding ? (
          <Badge kind={finding.status}>{STATUS_LABELS[finding.status]}</Badge>
        ) : contract.status === "processing" ? (
          <span className="animate-pulse">
            <Badge kind="pending">Checking</Badge>
          </span>
        ) : (
          // Never a spinner on a review that has already ended.
          <Badge kind="pending">Not checked</Badge>
        )}
      </div>

      {finding && <p className="mt-2 text-sm">{finding.summary}</p>}

      {finding?.quote && finding.clause && (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="w-full rounded-md border-l-4 border-accent bg-paper px-4 py-3 text-left hover:bg-missing-bg"
          >
            <span className="contract-text contract-quote block text-sm">“{finding.quote}”</span>
            <span className="mt-2 block text-xs text-muted">
              {finding.location ?? "No section number"} ·{" "}
              <span className="text-accent underline">{open ? "Hide full clause" : "Show full clause"}</span>
            </span>
          </button>
          {open && (
            <div className="mt-2">
              <Clause clause={finding.clause} wrapped={contract.hasRealPages ?? false} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
