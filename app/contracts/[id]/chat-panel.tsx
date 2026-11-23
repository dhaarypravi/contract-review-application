"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ask } from "@/lib/client";
import type { ContractSummary, MessageView } from "@/lib/dto";
import { MAX_QUESTION_LENGTH, QUOTE_REMOVED } from "@/limits";
import type { Citation } from "@/services/chat";
import { Clause, Notice } from "../../components/ui";

export function ChatPanel({
  contractId,
  ready,
  status,
}: {
  contractId: string;
  ready: boolean;
  status: ContractSummary["status"];
}) {
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const body = await api<{ messages: MessageView[] }>(`/api/contracts/${contractId}/chat`);
      setMessages(body.messages);
      setHistoryError(null);
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "The conversation could not be loaded.");
    }
  }, [contractId]);

  useEffect(() => {
    void loadHistory();
    return () => aborter.current?.abort();
  }, [loadHistory]);

  // Follow the answer only while the reader is already at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, pending]);

  async function submit() {
    const question = draft.trim();
    if (!question || pending || !ready) return;
    setError(null);
    setDraft("");
    setPending({ question, answer: "" });
    stick.current = true;
    aborter.current = new AbortController();
    const { signal } = aborter.current;

    let answer = "";
    let failed: string | null = null;
    try {
      for await (const frame of ask(contractId, question, signal)) {
        if (frame.type === "delta") {
          answer += frame.text;
          setPending({ question, answer });
        } else if (frame.type === "error") failed = frame.error;
      }
    } catch (caught) {
      if (!signal.aborted) failed = caught instanceof Error ? caught.message : "The answer could not be completed.";
    }
    if (failed) {
      setError(failed);
      if (!answer) setDraft(question); // nothing was answered, so keep the question
    }
    // After Stop, give the server a moment to save the part already written.
    if (signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
    // The server's copy is the truth; local turns would drift from it.
    await loadHistory();
    setPending(null);
  }

  return (
    <section
      aria-label="Questions about this contract"
      className="flex max-h-[calc(100vh-6rem)] flex-col lg:max-h-[calc(100vh-14rem)] rounded-lg border border-line bg-card lg:sticky lg:top-6"
    >
      <h2 className="border-b border-line px-4 py-3 font-medium">Ask about this contract</h2>

      <div
        ref={scroller}
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          stick.current = scrollHeight - scrollTop - clientHeight < 40;
        }}
        className="min-h-40 flex-1 space-y-5 overflow-y-auto px-4 py-4"
      >
        {historyError && (
          <Notice tone="error">
            {historyError}{" "}
            <button type="button" className="font-medium underline" onClick={() => void loadHistory()}>
              Try again
            </button>
          </Notice>
        )}
        {messages === null && !historyError && <p className="text-sm text-muted">Loading conversation…</p>}
        {messages?.length === 0 && !pending && (
          <p className="text-sm text-muted">
            {ready
              ? "Answers come only from this contract, with the clause quoted."
              : status === "processing"
                ? "You can ask questions once the review has finished."
                : "Questions are not available, because this contract could not be reviewed."}
          </p>
        )}
        {messages?.map((message) =>
          message.role === "user" ? (
            <Question key={message.id} text={message.content} />
          ) : (
            <Answer key={message.id} content={message.content} citations={message.citations} />
          ),
        )}
        {pending && (
          <>
            <Question text={pending.question} />
            <div className="text-sm whitespace-pre-wrap" aria-live="polite" aria-busy="true">
              {pending.answer || <span className="animate-pulse text-muted">Reading the contract and checking quotes…</span>}
            </div>
          </>
        )}
      </div>

      <form
        className="space-y-2 border-t border-line p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          disabled={!ready}
          aria-label="Your question"
          placeholder={ready ? "How much notice is needed to end it?" : ""}
          className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-sm disabled:opacity-60"
        />
        <div className="flex justify-end">
          {pending ? (
            <button
              type="button"
              onClick={() => aborter.current?.abort()}
              className="rounded-md border border-line px-4 py-1.5 text-sm"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!ready || !draft.trim()}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-60"
            >
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Question({ text }: { text: string }) {
  return <p className="ml-8 rounded-lg bg-missing-bg px-3 py-2 text-sm whitespace-pre-wrap">{text}</p>;
}

function Answer({ content, citations }: { content: string; citations: Citation[] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm whitespace-pre-wrap">{content}</p>
      {content.includes(QUOTE_REMOVED) && (
        <Notice tone="warning">
          Part of this answer relied on wording that is not in the contract. That wording was removed, so treat the text
          around it with caution.
        </Notice>
      )}
      {citations.map((citation) => (
        <CitationCard key={citation.quote} citation={citation} />
      ))}
    </div>
  );
}

function CitationCard({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const section =
    citation.sectionLabel && (/^\d/.test(citation.sectionLabel) ? `Section ${citation.sectionLabel}` : citation.sectionLabel);
  const location = [section, citation.pageNumber ? `page ${citation.pageNumber}` : null].filter(Boolean).join(", ");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full rounded-md border-l-4 border-accent bg-paper px-3 py-2 text-left hover:bg-missing-bg"
      >
        <span className="contract-text contract-quote block text-sm">“{citation.quote}”</span>
        <span className="mt-1 block text-xs text-muted">
          Verified · {location || "No section number"} ·{" "}
          <span className="text-accent underline">{open ? "Hide full clause" : "Show full clause"}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <Clause clause={citation.clause} wrapped={citation.pageNumber !== null} />
        </div>
      )}
    </div>
  );
}
