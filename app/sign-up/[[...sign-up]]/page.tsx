import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <div className="flex justify-center py-8">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <SignUp fallbackRedirectUrl="/contracts" />
      </Suspense>
    </div>
  );
}
