# Contract review

Upload a contract (PDF, DOCX or TXT, up to 20 MB) and it is checked against eight points: parties, start date and term, payment terms, termination, limitation of liability, confidentiality, governing law and auto-renewal. Each point comes back as **found**, **not found** or **unclear**, with a one-line summary and the clause quoted word for word. You can then ask follow-up questions in a streaming chat.

The principle behind every decision: **nothing is reported as a finding unless it is in the document.** The model proposes a quote. The server checks that quote against the contract, and a "found" without a verified quote is impossible, in the code and in the database.

## Setup

You need Docker. Everything else runs in containers.

### 1. Clerk (sign-in)

1. Create a free account at [dashboard.clerk.com](https://dashboard.clerk.com) and create an application with **email** sign-in.
2. Open **API keys** and copy the publishable key (`pk_test_...`) and the secret key (`sk_test_...`).
3. To try two users, sign up twice with addresses such as `anna+clerk_test@example.com` and `ben+clerk_test@example.com`. These need no inbox on a development instance: the code is `424242`.

### 2. A model provider key (one of these)

| Provider | Where | Notes |
|---|---|---|
| Google AI Studio (default) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free, no card |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Free models: 20 requests a minute, 50 a day |

Free tiers may log or train on what is sent. Use fictional contracts, such as the ones in `samples/`.

### 3. Run

```bash
cp .env.example .env      # then fill in the keys
docker compose up --build
```

Open http://localhost:3000.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `CLERK_SECRET_KEY` | Clerk secret key |
| `LLM_PROVIDER` | `gemini` or `openrouter` |
| `GEMINI_API_KEY` or `OPENROUTER_API_KEY` | The key for that provider |

If port 3000 is taken, change `WEB_PORT` **and** `APP_URL` together (for example `3100` and `http://localhost:3100`). Tokens issued for any other origin are refused.

### Developing without rebuilding containers

```bash
npm install
docker compose up -d postgres redis
npm run db:push
npm run dev            # one terminal
npm run dev:worker     # another
npm test               # needs postgres
npm run evaluate       # needs a model key
```

## Architecture

```
Browser (React)
   |  Clerk session
   v
Next.js app ---- middleware.ts: verifies the session, denies by default
   |             app/api/*: resolve user, validate, call a service, map errors
   |                 |
   |  enqueue        |  chat: streams NDJSON
   v                 v
Redis (BullMQ)    src/services ----> model provider (Gemini or OpenRouter)
   |                 |
   v                 v
Worker ---------> Postgres + pgvector
                  contracts, chunks + embeddings, findings, chat
```

An upload is validated, stored, recorded as `processing` and queued, and the request returns. The worker does the slow part: **extract → chunk → embed → review**. Finished steps are kept, so a retry resumes where it stopped. A job whose worker died is picked up again.

| Path | What it holds |
|---|---|
| `middleware.ts`, `src/lib/auth.ts` | Session check, the only source of the user id |
| `src/services/contracts.ts` | Every read and delete of user data |
| `src/services/extract.ts`, `docx-numbering.ts`, `chunk.ts` | File to text to clauses |
| `src/services/retrieve.ts`, `src/checklist.ts` | Search, and what to search for |
| `src/services/verify.ts`, `answer-gate.ts` | The quote check, and the gate that applies it to the chat stream |
| `src/services/review.ts`, `chat.ts`, `ingest.ts` | Prompts and orchestration |

## Stack, and why

| Choice | Why |
|---|---|
| **Next.js 15, route handlers** | A real HTTP API that can be called with curl, and one application to run. The layering is in the code: the worker and the evaluation script use `src/services` with no HTTP at all. |
| **Postgres + pgvector** | The tenant filter is enforced by the database that owns the row. With a separate vector store, two systems could disagree about who owns what. |
| **No vector index** | Every search is filtered to one contract first, so there are at most a few hundred rows. An exact scan is fast and loses no recall. |
| **Drizzle** | Typed queries whose SQL can be read back. The isolation tests assert on that SQL. |
| **Idempotent SQL migration** | It runs unattended in `docker compose up` and never prompts. It also detects a changed embedding width, and warns before rebuilding the column. |
| **BullMQ worker** | Parsing a large file and waiting for a rate-limited model cannot block the API, and a restart does not lose the work. |
| **Gemini by default** | OpenRouter's free models allow 50 requests a day per account. A typical contract costs about 10 (two for embeddings, eight for the checklist), which is five contracts a day before any chat. Both speak the OpenAI request shape, so supporting both is a base URL, a key and two model names. |

## Chunking

Contracts are split on **their own clause headings**, never on a fixed window. Cutting every thousand characters separates "either party may terminate" from "on thirty days' written notice", and after that no search can get the clause back.

- Headings are numbered (`7.`, `7.2`), named (`ARTICLE IV`, `Schedule A`) or short lines in capitals. A number has to follow on from the clauses before it, because a wrapped line can start with "30 days".
- A heading alone on its line is folded into the clause below. A sub-clause borrows its parent's title, so it is labelled `7.1 (TERMINATION)`.
- A section over 1,800 characters is split at paragraph, sub-item or sentence ends, with 200 characters of overlap and the same label.
- Every chunk records its character offsets and pages. A test checks that those offsets give back exactly the chunk's text.

**Pages and sections.** PDF text keeps real page numbers, and running headers and footers are removed so that a quote can cross a page break. DOCX and TXT have no fixed pages, so findings cite sections, and the page says so. Word keeps automatic clause numbers outside its text, where the text extractor loses them, so they are resolved from the numbering definitions and written back first.

## Retrieval for each checklist item

Each item has **its own query, written to read like the clause**, because embedding the words "limitation of liability" does not find "neither party shall be liable for indirect damages". Two searches run inside the one contract: by meaning (pgvector cosine) and by keyword. They are merged as `0.65 × similarity + 0.35 × keyword share − 0.05 × negative keywords`, and the best clauses go to the model: at least six, and up to fourteen while they total under 6,000 characters, because six one-sentence sub-clauses are only a paragraph. The keyword part rescues clauses the embedding ranks low; it does not drive the ranking.

| Item | What is particular about it |
|---|---|
| Parties | Lives in an unheaded opening, so the opening is always included. Query uses recital wording ("by and between", "hereinafter"). Placeholders such as `[COMPANY]` are unclear. |
| Start date and term | The opening is always included (effective date). "terminate" counts against a chunk, because "term" matches it. |
| Payment terms | Amount, due date and late interest are often separate sub-clauses. |
| Termination | Looks for rights, grounds and notice together. |
| Limitation of liability | A cap or an exclusion counts. An indemnity or a warranty disclaimer alone does not. |
| Confidentiality | The duty and its duration are usually apart, so a clear duty with no visible duration is still found. |
| Governing law | A court or arbitration venue without a law is unclear. |
| Auto-renewal | Often one sentence inside the term clause. A term that simply expires is *not found*; "does not renew" is *found*. |

There is one model call per item. Each item needs different excerpts, and a failed call loses one item instead of eight. Replies are parsed defensively and validated with zod; a reply that cannot be read is sent back once with the error.

## How quotes are checked

`findQuote` in `src/services/verify.ts` normalises the quote and the contract the same way (whitespace, curly quotes, dashes, ligatures, invisible characters, case) while keeping a map back to the original offsets. It then looks for an exact match on word boundaries.

> Forgive everything that is not a word. Forgive nothing that is.

- **Not byte-exact**, because extraction and models both disturb punctuation and spacing, and nearly every genuine quote would fail.
- **Not fuzzy**, because any threshold loose enough for punctuation is loose enough for a reworded sentence.
- What is stored and shown is a slice of the contract, never the model's copy.
- A quote that fails turns the item **unclear**. The quote and the summary built on it are dropped.
- The database refuses a `found` finding without a verified quote (a `CHECK` constraint).
- **In the chat, every quote is checked before it is shown** (`src/services/answer-gate.ts`). The model's stream goes through a gate on the server: a quotation is held back until it is complete and verified, and nothing at all is shown until one quote has passed. After that the text streams freely. A quote that fails is replaced by a note and the answer carries a warning. If no quote can be verified, the reader gets a fixed reply instead of the model's claims. The cost is a short wait before the first words.

## How each user's data is kept separate

1. **The user id comes only from the Clerk session**, verified on the server on every request. No route reads one from a body, query or header.
2. **Middleware denies by default.** A new route is protected without anyone remembering to do it. Tokens issued for another origin are refused.
3. **One function loads a contract**, with `WHERE id = ? AND user_id = ?`. Someone else's contract gives the same 404 as a missing one, so ids cannot be probed.
4. **`user_id` is on every table**, and every query states it, including both halves of the vector search.
5. **The database enforces it too**: child rows reference `(contract_id, user_id)` together, so a row that pairs one user's contract with another user cannot be stored.
6. **Tests** try each path as a second user and assert on the generated SQL of the real queries, because a filter that silently disappears can still return plausible rows.

To try it: copy a contract's id as user A, sign in as user B, and in the browser console run `fetch('/api/contracts/<id>').then(r => r.status)`. It gives 404, as do `DELETE` and both `/chat` methods.

## Errors and limits

Rate limits, busy providers, calls that hang, empty replies and unreadable answers are retried with backoff (within a request, then up to three job attempts). A daily limit is not retried, and is reported as such. If some items cannot be checked, the review is kept and those items say "Not checked" with the reason. Messages shown to users never contain provider output.

## Tests and evaluation

`npm test` runs 104 tests: quote checking in both directions, the chat gate (every case also fed one character at a time, because a stream can split anywhere), chunking and extraction (including a real PDF and an automatically numbered Word file), isolation, and the pipeline against a stand-in model that invents quotes, returns broken JSON, throttles, and fails mid-stream.

`npm run evaluate` runs the real pipeline over two sample contracts with complementary gaps, and prints the items that are right and the "found" items whose quote is verified. Some expectations accept more than one status, with the reason written beside them in `samples/expected.json`. Two contracts are a smoke test, not an accuracy figure.

Result on 23 November 2026 with `gemini-flash-lite-latest`:

```
checklist items correct       : 16/16
"found" with a verified quote : 14/14
```

The first run scored the same, but reading its summaries showed a wrong one: for the NDA it said that the confidentiality period "is not specified", while clause 5.2 says three years. The model had been shown too few clauses and described the whole contract from them. It is now shown more, told never to say what a contract lacks, and the evaluation fails if that claim returns. A review took between 20 seconds and 2 minutes, depending on the provider's free tier.

## Known limitations

- **A verified quote can still be a poor match for its summary.** The check proves the words are in the contract, not that the summary follows from them.
- **A search miss can become "not found".** For a long contract the model sees the best 6 to 14 clauses for an item, not the whole text.
- **One quote per item.** A summary can draw on several sub-clauses (for example notice, breach and insolvency under termination), while only the main one is quoted.
- The same holds for the chat: the gate proves each quote is real, but the explanation after it is the model's.
- The gate recognises quotations in double quotes and quote tags. Wording in single quotes is treated as ordinary text.
- A quote may skip words with "...", if its parts appear in order; the full span is shown.
- No OCR. A scanned PDF fails with a message; a page without text in a mixed PDF is named as not reviewed.
- Multi-column pages and complex tables may be read in the wrong order.
- Unusual numbering schemes fall back to longer chunks without section labels.
- English only.
- Files sit on a local volume, unencrypted. An upload is held in memory while it is validated.
- A failed contract has to be deleted and uploaded again.
- There is no per-user request limit, and the size a DOCX expands to is not capped.
- The queue retries and recovers, but has not been load-tested.
- `npm audit` reports advisories for some pinned versions (`drizzle-orm`, `zod`, `postcss` inside Next, and test tooling). The affected features are not used with user input here, but they should be upgraded.

**With more time, in order:** a second look at the whole contract before saying "not found"; a larger evaluation set with precision and recall per item; comparing two versions of a contract; rule-based risk flags; a retry button; component and browser tests.

## Assumptions

- A DOCX or TXT finding cites its section, because those formats have no fixed pages.
- "Word for word" means the same words in the same order; line breaks and quote-mark shapes may differ.
- One review is kept per contract.
- A start date or a term alone is "found", with the missing half noted in the summary.

## How AI tools were used

Claude Code (Claude Opus 5.5) wrote the code, the tests, the fictional sample contracts and this README, working from a written build specification. It also ran the checks: unit and integration tests; an HTTP run with signed tokens for two users and killing the worker in the middle of a review, both against a stand-in model; and browser runs, the last of them with real Clerk accounts and the real model.

Checks on real files found problems that reading the code had not: Next.js cutting uploads at 10 MB when middleware is present, Word clause numbers disappearing, keyword search missing phrases that wrap across PDF lines, and double-spaced PDFs being read as separate paragraphs. A test written for the chat gate caught an unfinished tag carrying an unchecked quote through, before it was released.
