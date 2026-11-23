"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_UPLOAD_BYTES } from "@/limits";
import { api, formatDate, formatSize, uploadFile } from "@/lib/client";
import type { ContractSummary } from "@/lib/dto";
import { Badge, Notice } from "../components/ui";

const POLL_MS = 3000;
const LABELS = { processing: "Processing", reviewed: "Reviewed", failed: "Failed" } as const;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export function ContractsClient() {
  const [contracts, setContracts] = useState<ContractSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ contracts: ContractSummary[] }>("/api/contracts");
      setContracts(body.contracts);
      setLoadError(null);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const processing = contracts?.some((contract) => contract.status === "processing") ?? false;
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [processing, load]);

  async function upload(file: File) {
    setActionError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setActionError(`${file.name} is ${formatSize(file.size)}. The limit is 20 MB.`);
      return;
    }
    setProgress(0);
    try {
      await uploadFile("/api/contracts", file, setProgress);
      await load();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setProgress(null);
    }
  }

  async function remove(contract: ContractSummary) {
    if (!window.confirm(`Delete "${contract.filename}" with its review and chat? This cannot be undone.`)) return;
    setActionError(null);
    setDeleting(contract.id);
    try {
      await api(`/api/contracts/${contract.id}`, { method: "DELETE" });
    } catch (error) {
      setActionError(messageOf(error));
    }
    await load();
    setDeleting(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My contracts</h1>
          <p className="mt-1 text-sm text-muted">PDF, DOCX or TXT, up to 20 MB.</p>
        </div>
        <input
          ref={input}
          type="file"
          accept=".pdf,.docx,.txt"
          className="sr-only"
          aria-label="Contract file"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = ""; // so the same file can be chosen again
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          disabled={progress !== null}
          onClick={() => input.current?.click()}
          className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-60"
        >
          {progress === null ? "Upload contract" : progress < 100 ? `Uploading ${progress}%` : "Saving…"}
        </button>
      </div>

      {actionError && <Notice tone="error">{actionError}</Notice>}
      {loadError && (
        <Notice tone="error">
          {loadError}{" "}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}

      {contracts === null && !loadError && (
        <div aria-busy="true" aria-label="Loading contracts" className="space-y-3">
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-16 animate-pulse rounded-lg bg-missing-bg" />
          ))}
        </div>
      )}

      {contracts?.length === 0 && (
        <div className="rounded-lg border border-dashed border-line p-12 text-center">
          <p className="font-medium">No contracts yet</p>
          <p className="mt-1 text-sm text-muted">Upload one to have it checked. It usually takes about a minute.</p>
        </div>
      )}

      {contracts && contracts.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card">
          {contracts.map((contract) => (
            <li key={contract.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1 basis-64">
                <Link
                  href={`/contracts/${contract.id}`}
                  className="block truncate font-medium hover:underline"
                  title={contract.filename}
                >
                  {contract.filename}
                </Link>
                <p className="text-sm text-muted">
                  {formatSize(contract.sizeBytes)} · {formatDate(contract.createdAt)}
                </p>
                {contract.statusDetail && (
                  <p className={`mt-1 text-sm ${contract.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {contract.statusDetail}
                  </p>
                )}
              </div>
              <Badge kind={contract.status}>{LABELS[contract.status]}</Badge>
              <button
                type="button"
                disabled={deleting === contract.id}
                onClick={() => void remove(contract)}
                className="text-sm text-danger hover:underline disabled:opacity-60"
                aria-label={`Delete ${contract.filename}`}
              >
                {deleting === contract.id ? "Deleting…" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
