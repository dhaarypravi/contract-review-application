import { Queue } from "bullmq";
import IORedis from "ioredis";
import { redisUrl } from "@/config";

export const QUEUE_NAME = "contract-review";
export const ATTEMPTS = 3;

export interface ReviewJob {
  contractId: string;
  userId: string;
}

// Workers block on Redis, so BullMQ requires this to be null for them.
export const createConnection = (maxRetriesPerRequest: number | null) =>
  new IORedis(redisUrl(), { maxRetriesPerRequest });

const globalForQueue = globalThis as unknown as { __queue?: Queue<ReviewJob> };

/** Created on first use, so that a build never needs Redis. */
export function reviewQueue(): Queue<ReviewJob> {
  return (globalForQueue.__queue ??= new Queue<ReviewJob>(QUEUE_NAME, { connection: createConnection(1) }));
}

/**
 * The job id is the contract id: submitting a contract twice is a no-op instead
 * of two ingests racing to write the same chunks. Finished jobs are removed, so
 * the id does not block a later run.
 */
export async function enqueueReview(job: ReviewJob): Promise<void> {
  await reviewQueue().add("review", job, {
    jobId: job.contractId,
    attempts: ATTEMPTS,
    backoff: { type: "exponential", delay: 20_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}
