import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <div className="flex justify-center py-8">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <SignIn fallbackRedirectUrl="/contracts" />
      </Suspense>
    </div>
  );
}
