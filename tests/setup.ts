import "dotenv/config";
import { databaseUrl } from "@/config";

// The tests write to a real Postgres. They delete only rows they created, and
// they refuse to run against anything that is not on this machine.
const host = new URL(databaseUrl()).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(host)) {
  throw new Error(`Refusing to run tests against a non-local database (${host}).`);
}
