import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddingDimensions } from "@/config";
import { chatMessages, chunks, contracts, db, findings, sqlClient } from "@/db";
import { migrate } from "@/db/migrate";
import { NotFoundError } from "@/lib/errors";
import {
  chatQuery,
  chunkSpansQuery,
  deleteOwnedContract,
  deleteQuery,
  findingsQuery,
  listQuery,
  loadOwnedContract,
  ownedContractQuery,
  updateOwnedContract,
} from "@/services/contracts";
import { saveFinding } from "@/services/review";
import { lexicalQuery, openingQuery, retrieve, semanticQuery } from "@/services/retrieve";

const userA = `test_a_${randomUUID()}`;
const userB = `test_b_${randomUUID()}`;
const vector = Array.from({ length: embeddingDimensions() }, (_, i) => (i === 0 ? 1 : 0));
let contractA: string;
let contractB: string;

async function seed(userId: string) {
  const [contract] = await db
    .insert(contracts)
    .values({
      userId,
      filename: "secret.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      storagePath: "nowhere",
      status: "reviewed",
      fullText: "Secret liability clause",
    })
    .returning();
  const scope = { contractId: contract!.id, userId };
  await db.insert(chunks).values({
    ...scope, ordinal: 0, content: "Secret liability clause", charStart: 0, charEnd: 23, embedding: vector,
  });
  await db.insert(findings).values({ ...scope, itemKey: "parties", status: "not_found", summary: "Secret" });
  await db.insert(chatMessages).values({ ...scope, role: "user", content: "Secret question" });
  return contract!.id;
}

beforeAll(async () => {
  await migrate();
  contractA = await seed(userA);
  contractB = await seed(userB);
});

// Deletes exactly the rows created here. Nothing truncates a table.
afterAll(async () => {
  await db.delete(contracts).where(eq(contracts.userId, userA));
  await db.delete(contracts).where(eq(contracts.userId, userB));
  await sqlClient.end();
});

describe("user B holding user A's contract id", () => {
  it("cannot load it, and cannot tell it from a missing one", async () => {
    const theirs = await loadOwnedContract(contractA, userB).catch((error) => error);
    const missing = await loadOwnedContract(randomUUID(), userB).catch((error) => error);
    const malformed = await loadOwnedContract("not-a-uuid", userB).catch((error) => error);
    for (const error of [theirs, missing, malformed]) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect([error.status, error.code, error.message]).toEqual([404, "not_found", "Contract not found."]);
    }
  });

  it("does not see it in a list", async () => {
    expect((await listQuery(userB)).map((row) => row.id)).toEqual([contractB]);
  });

  it("cannot search it by meaning or by keyword", async () => {
    expect(await semanticQuery(contractA, userB, vector)).toEqual([]);
    expect(await lexicalQuery(contractA, userB, vector, ["liability"])).toEqual([]);
    expect(await openingQuery(contractA, userB)).toEqual([]);
    expect(await retrieve(contractA, userB, vector, { keywords: ["liability"], includeOpening: true }, 6)).toEqual([]);
    // The same calls work for the owner, so the checks above are not vacuous.
    expect(await retrieve(contractA, userA, vector, { keywords: ["liability"] }, 6)).toHaveLength(1);
  });

  it("keyword search finds a phrase that wraps across lines, and takes symbols literally", async () => {
    const scope = { contractId: contractB, userId: userB };
    await db.insert(chunks).values({
      ...scope, ordinal: 1, content: "Liability shall not\nexceed $5 (five).", charStart: 0, charEnd: 37, embedding: vector,
    });
    const matches = async (keyword: string) => (await lexicalQuery(contractB, userB, vector, [keyword])).length;
    expect(await matches("shall not exceed")).toBe(1);
    expect(await matches("$5 (five)")).toBe(1);
    expect(await matches("s.all")).toBe(0);
  });

  it("cannot read its findings, clauses or chat", async () => {
    expect(await findingsQuery(contractA, userB)).toEqual([]);
    expect(await chunkSpansQuery(contractA, userB)).toEqual([]);
    expect(await chatQuery(contractA, userB)).toEqual([]);
  });

  it("cannot delete or change it", async () => {
    await expect(deleteOwnedContract(contractA, userB)).rejects.toBeInstanceOf(NotFoundError);
    await updateOwnedContract(contractA, userB, { status: "failed" });
    expect((await loadOwnedContract(contractA, userA)).status).toBe("reviewed");
  });

  it("cannot attach rows to it: the database refuses", async () => {
    const scope = { contractId: contractA, userId: userB };
    await expect(db.insert(chatMessages).values({ ...scope, role: "user", content: "x" })).rejects.toThrow(/foreign key/);
    await expect(
      db.insert(chunks).values({ ...scope, ordinal: 1, content: "x", charStart: 0, charEnd: 1, embedding: vector }),
    ).rejects.toThrow(/foreign key/);
  });

  it("cannot overwrite a finding through the upsert", async () => {
    const hostile = {
      status: "unclear", summary: "Hacked", quote: null, sectionLabel: null, pageNumber: null,
      quoteVerified: false, quoteCharStart: null, quoteCharEnd: null, chunkId: null,
    } as const;
    await saveFinding(contractA, userB, "parties", hostile).catch(() => {});
    expect((await findingsQuery(contractA, userA))[0]!.summary).toBe("Secret");
  });
});

describe("generated SQL", () => {
  // A filter built as `cond && extra` can become undefined, and the ORM then
  // emits SQL with no tenant predicate. Nothing throws, and checking returned
  // rows can miss it, so this asserts on the SQL of the real queries.
  const queries = {
    listQuery: () => listQuery(userA),
    ownedContractQuery: () => ownedContractQuery(contractA, userA),
    deleteQuery: () => deleteQuery(contractA, userA),
    findingsQuery: () => findingsQuery(contractA, userA),
    chatQuery: () => chatQuery(contractA, userA),
    chunkSpansQuery: () => chunkSpansQuery(contractA, userA),
    semanticQuery: () => semanticQuery(contractA, userA, vector),
    lexicalQuery: () => lexicalQuery(contractA, userA, vector, ["liability"]),
    lexicalQueryWithoutKeywords: () => lexicalQuery(contractA, userA, vector, []),
    openingQuery: () => openingQuery(contractA, userA),
  };

  it.each(Object.entries(queries))("%s filters by user", (_name, build) => {
    const { sql, params } = build().toSQL();
    expect(sql.slice(sql.indexOf(" where "))).toContain('"user_id" = $');
    expect(params).toContain(userA);
  });
});

describe("the found-means-verified invariant", () => {
  it("is refused by the database as well as the code", async () => {
    await expect(
      db.insert(findings).values({
        contractId: contractA, userId: userA, itemKey: "termination", status: "found", summary: "x", quoteVerified: false,
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it("deleting a contract removes everything under it", async () => {
    const id = await seed(userA);
    await deleteOwnedContract(id, userA);
    for (const table of [chunks, findings, chatMessages]) {
      expect(await db.select().from(table).where(eq(table.contractId, id))).toEqual([]);
    }
  });
});
