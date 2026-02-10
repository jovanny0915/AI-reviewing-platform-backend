/**
 * Phase 1.4: BullMQ worker. Run when REDIS_URL is set: npm run worker
 * Processes document jobs (metadata + OCR) from the queue.
 */

import "dotenv/config";
import { Worker } from "bullmq";
import { processDocument } from "./lib/document-processor.js";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("REDIS_URL is required to run the worker. For in-process processing, do not run the worker.");
  process.exit(1);
}

const connection = { url: REDIS_URL };
const worker = new Worker(
  "document-processing",
  async (job) => {
    const { documentId, forceOcr } = job.data;
    await processDocument({ documentId, forceOcr: forceOcr ?? false });
  },
  { connection, concurrency: 2 }
);

worker.on("completed", (job) => {
  console.log("[worker] Job completed:", job.id, job.data.documentId);
});
worker.on("failed", (job, err) => {
  console.error("[worker] Job failed:", job?.id, job?.data?.documentId, err?.message);
});

console.log("[worker] Document processing worker started (Redis)");
