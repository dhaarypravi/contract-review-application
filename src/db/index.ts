import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "@/config";
import * as schema from "./schema";

// Cached on globalThis so Next's dev reloads do not open a new pool each time.
const globalForDb = globalThis as unknown as { __sql?: postgres.Sql };

export const sqlClient = (globalForDb.__sql ??= postgres(databaseUrl(), { max: 10, onnotice: () => {} }));
export const db = drizzle(sqlClient, { schema });
export * from "./schema";
