import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { CHECKLIST_KEYS } from "@/checklist";
import { llmConfig } from "@/config";
import { contracts, db, sqlClient } from "@/db";
import { findingsQuery, loadOwnedContract } from "@/services/contracts";
import { MIME_TYPES, sniffKind } from "@/services/extract";
import { processContract } from "@/services/ingest";
import { findQuote } from "@/services/verify";

/**
 * Runs the real pipeline over the sample contracts and scores the findings.
 * Two contracts are a smoke test, not an accuracy figure.
 */
const Expected = z.array(
  z.object({
    file: z.string(),
    items: z.record(
      z.string(),
      z.object({
        accept: z.array(z.enum(["found", "not_found", "unclear"])).min(1),
        /** A "found" quote must contain one of these. */
        quoteIncludes: z.array(z.string()).optional(),
        /** Claims the summary must not make. */
        summaryExcludes: z.array(z.string()).optional(),
        why: z.string().optional(),
      }),
    ),
  }),
);

const PASS_MARK = 14;
const samples = fileURLToPath(new URL("../samples/", import.meta.url));
const userId = `eval_${randomUUID()}`;

async function main() {
  const expected = Expected.parse(JSON.parse(await readFile(path.join(samples, "expected.json"), "utf8")));
  const config = llmConfig();
  console.log(`provider ${config.provider}, chat ${config.chatModel}, embeddings ${config.embeddingModel}\n`);

  let total = 0;
  let correct = 0;
  let found = 0;
  let verified = 0;

  for (const sample of expected) {
    const storagePath = path.join(samples, sample.file);
    const bytes = await readFile(storagePath);
    const kind = sniffKind(bytes);
    if (!kind) throw new Error(`${sample.file}: unsupported type`);

    const [row] = await db
      .insert(contracts)
      .values({ userId, filename: sample.file, mimeType: MIME_TYPES[kind], sizeBytes: bytes.length, storagePath })
      .returning({ id: contracts.id });
    const started = Date.now();
    await processContract(row!.id, userId);

    const contract = await loadOwnedContract(row!.id, userId);
    const findings = new Map((await findingsQuery(row!.id, userId)).map((finding) => [finding.itemKey, finding]));
    console.log(`${sample.file}: ${contract.status} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (contract.statusDetail) console.log(`  ${contract.statusDetail}`);

    for (const key of CHECKLIST_KEYS) {
      const rule = sample.items[key];
      if (!rule) throw new Error(`${sample.file}: no expectation for ${key}`);
      const finding = findings.get(key);
      total++;

      // Checked again here instead of trusting the stored flag.
      const quoteIsReal = Boolean(finding?.quote && findQuote(contract.fullText ?? "", finding.quote));
      if (finding?.status === "found") {
        found++;
        if (quoteIsReal && finding.quoteVerified) verified++;
      }
      const flat = (text: string) => text.replace(/\s+/g, " ").toLowerCase();
      const rightClause =
        finding?.status !== "found" ||
        !rule.quoteIncludes ||
        rule.quoteIncludes.some((text) => flat(finding.quote ?? "").includes(flat(text)));
      const badClaim = rule.summaryExcludes?.find((text) => flat(finding?.summary ?? "").includes(flat(text)));
      const pass = finding !== undefined && rule.accept.includes(finding.status) && rightClause && !badClaim;
      if (pass) correct++;

      console.log(`  ${pass ? "ok  " : "MISS"} ${key.padEnd(24)} ${(finding?.status ?? "not checked").padEnd(11)} ${finding?.summary ?? ""}`);
      if (finding?.quote) console.log(`       ${finding.sectionLabel ?? ""}: "${finding.quote.replace(/\s+/g, " ").slice(0, 140)}"`);
      if (!pass) console.log(`       expected ${rule.accept.join(" or ")}${rightClause ? "" : `, quoted the wrong clause: ${finding?.quote}`}${badClaim ? `, and the summary must not say "${badClaim}"` : ""}`);
    }
    console.log();
  }

  console.log(`checklist items correct       : ${correct}/${total}`);
  console.log(`"found" with a verified quote : ${verified}/${found}`);
  if (verified !== found || correct < PASS_MARK) process.exitCode = 1;
}

try {
  await main();
} finally {
  await db.delete(contracts).where(eq(contracts.userId, userId));
  await sqlClient.end();
}
