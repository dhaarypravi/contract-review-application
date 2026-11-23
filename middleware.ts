import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Denies by default. A new route is protected because nobody had to remember to
 * protect it. This is a first gate, not the only one: every API route resolves
 * the user itself and scopes its own queries.
 */
const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(
  async (auth, request) => {
    if (isPublic(request)) return;
    const { userId, redirectToSignIn } = await auth();
    if (userId) return;
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: { code: "unauthenticated", message: "Please sign in." } },
        { status: 401 },
      );
    }
    return redirectToSignIn({ returnBackUrl: request.url });
  },
  {
    // Refuses a token that was issued for another site.
    authorizedParties: [process.env.APP_URL || "http://localhost:3000"],
    // Optional: Clerk's public key, so that signatures are checked without a
    // network call. Left out, Clerk fetches the key itself.
    jwtKey: process.env.CLERK_JWT_KEY || undefined,
  },
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
