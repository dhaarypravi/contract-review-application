# Demo video script (5 minutes at most)

## Before recording

- Two Clerk users, A and B, each signed in to its own browser profile.
- As A, upload `samples/services-agreement.pdf` and wait until it is reviewed. Check that auto-renewal is "not found". The model decides, so look before you record; `samples/mutual-nda.txt` should give "not found" for payment terms.
- Ask both questions below once, so you know the answers. Delete the contract and upload it again to clear the chat.
- Copy the contract's id from the address bar.
- If the provider is rate-limited, wait a minute. If it is the daily limit, switch `LLM_PROVIDER` in `.env` and run `docker compose up -d --build`. Changing provider rebuilds the stored vectors, so upload again.

## Script

| Time | Show | Say |
|---|---|---|
| 0:00 | Landing page, sign in as A | "Contracts are checked against eight fixed points. Sign-in is Clerk." |
| 0:20 | Upload `mutual-nda.txt`; the row shows "Processing" | "The request returns at once. A separate worker does the slow part." |
| 0:40 | Open the reviewed PDF instead of waiting | "Each item is found, not found or unclear." |
| 0:55 | Limitation of liability, click the quote | "The quote is a slice of the contract, with its section and page. Here is the whole clause." |
| 1:25 | Auto-renewal | "Not found. It does not assume a standard clause." |
| 1:45 | Ask: "How much notice is needed to end it?" | "The quote is checked against the contract before anything is shown. Then the explanation streams." |
| 2:15 | Ask: "Does the contract require insurance?" | "It can't answer this from the contract, so it says so." |
| 2:35 | Refresh the page | "Review and chat are still there." |
| 2:45 | Browser of user B: empty list, then A's contract address | "Same 404 as a contract that doesn't exist." |
| 3:05 | B's console: `fetch('/api/contracts/<id>',{method:'DELETE'}).then(r=>r.status)` | "Calling the API directly gives 404 too. Back as A, it's still there." |
| 3:25 | `src/services/verify.ts` | "Forgive everything that isn't a word, nothing that is. Not exact, not fuzzy." |
| 3:40 | `src/services/answer-gate.ts` | "The model's stream passes through this. An invented quote never reaches the browser." |
| 3:55 | `src/services/chunk.ts` | "Split on clause headings. A fixed window would cut a clause in half." |
| 4:10 | `src/checklist.ts`, `src/services/retrieve.ts` | "One query per item, written like the clause. Both searches carry the user id." |
| 4:30 | `src/services/contracts.ts`, `tests/isolation.test.ts` | "One loader, and tests that assert on the generated SQL." |
| 4:50 | Close | "Limitations and next steps are in the README." |
