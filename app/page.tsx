import { Show } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { CHECKLIST } from "@/checklist";

// Rendered per request: prerendering would need a real Clerk key at build time.
export const dynamic = "force-dynamic";

const button = "inline-block rounded-md bg-accent px-4 py-2 font-medium text-accent-ink";

export default function Home() {
  return (
    <div className="grid gap-10 py-6 md:grid-cols-[3fr_2fr]">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Check a contract against eight points</h1>
        <p className="mt-4 max-w-prose text-muted">
          Upload a PDF, Word or text contract. Each point comes back as found, not found or unclear, with the clause
          quoted word for word. Every quote is checked against the contract before you see it as a finding.
        </p>
        <div className="mt-6">
          <Suspense fallback={null}>
            <Show when="signed-in">
              <Link href="/contracts" className={button}>
                Go to my contracts
              </Link>
            </Show>
            <Show when="signed-out">
              <Link href="/sign-up" className={button}>
                Sign up to start
              </Link>
            </Show>
          </Suspense>
        </div>
      </section>
      <section aria-label="The checklist" className="rounded-lg border border-line bg-card p-5">
        <ul className="divide-y divide-line">
          {CHECKLIST.map((item) => (
            <li key={item.key} className="py-2">
              {item.label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
