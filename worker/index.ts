import "dotenv/config";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { contracts, db, sqlClient } from "@/db";
import { createConnection, enqueueReview, QUEUE_NAME, reviewQueue, type ReviewJob } from "@/queue";
import { processContract } from "@/services/ingest";

const worker = new Worker<ReviewJob>(
  QUEUE_NAME,
  async (job) => {
    const started = Date.now();
    await processContract(job.data.contractId, job.data.userId, {
      lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
    console.log(`contract ${job.data.contractId} done in ${Math.round((Date.now() - started) / 1000)}s`);
  },
  {
    connection: createConnection(null),
    // The bottleneck is a rate-limited network call, so more only means more 429s.
    concurrency: 2,
    // A job whose worker died is picked up again instead of staying "processing".
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

worker.on("ready", () => console.log("worker listening"));
worker.on("error", (error) => console.error("worker error:", error.message));
worker.on("failed", (job, error) => {
  console.warn(`contract ${job?.data.contractId} attempt ${job?.attemptsMade} failed: ${error.message}`);
  // The pipeline records its own failures. This covers a job BullMQ gave up on
  // without running it to the end, such as one that stalled too often.
  if (job && job.attemptsMade < (job.opts.attempts ?? 1) && !/stalled/i.test(error.message)) return;
  if (job) markAbandoned(job.data.contractId).catch((e) => console.error("could not record failure:", e));
});

async function markAbandoned(contractId: string) {
  const [row] = await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contractId));
  if (row?.status !== "processing") return;
  await db
    .update(contracts)
    .set({
      status: "failed",
      statusDetail: "The review was interrupted. Please delete this contract and upload it again.",
      updatedAt: new Date(),
    })
    .where(eq(contracts.id, contractId));
}

/** If Redis lost its jobs, "processing" rows would wait forever. Adding is a no-op when the job exists. */
async function requeueUnfinished() {
  const unfinished = await db
    .select({ contractId: contracts.id, userId: contracts.userId })
    .from(contracts)
    .where(eq(contracts.status, "processing"));
  for (const job of unfinished) await enqueueReview(job);
  if (unfinished.length) console.log(`checked ${unfinished.length} unfinished contract(s)`);
}

await requeueUnfinished();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await worker.close();
    await reviewQueue().close();
    await sqlClient.end();
    process.exit(0);
  });
}
