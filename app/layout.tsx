import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Contract review",
  description: "Check a contract against a fixed checklist, with every quote verified.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <ClerkProvider>
          <header className="border-b border-line bg-card">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
              <Link href="/" className="font-semibold">
                Contract review
              </Link>
              <Suspense fallback={<span className="text-sm text-muted">…</span>}>
                <Show when="signed-in">
                  <nav className="flex items-center gap-4 text-sm">
                    <Link href="/contracts" className="hover:underline">
                      My contracts
                    </Link>
                    <UserButton />
                  </nav>
                </Show>
                <Show when="signed-out">
                  <nav className="flex items-center gap-4 text-sm">
                    <Link href="/sign-in" className="hover:underline">
                      Sign in
                    </Link>
                    <Link href="/sign-up" className="rounded-md bg-accent px-3 py-1.5 text-accent-ink">
                      Sign up
                    </Link>
                  </nav>
                </Show>
              </Suspense>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
