import { auth } from "@clerk/nextjs/server";
import { UnauthorizedError } from "./errors";

export { loadOwnedContract } from "@/services/contracts";

/**
 * The user id comes from the Clerk session, which Clerk verifies on the server,
 * and from nowhere else. No route reads a user id from a body, query or header.
 */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();
  return userId;
}
