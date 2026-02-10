/**
 * Phase 1.4: Async processing. BullMQ when REDIS_URL is set; otherwise in-process queue
 * so upload returns immediately and processing runs in the background.
 */

export type DocumentProcessingJobData = {
  documentId: string;
  forceOcr?: boolean;
};

type JobHandler = (data: DocumentProcessingJobData) => Promise<void>;

let handler: JobHandler | null = null;
let useBull: boolean = false;
let addToBull: ((data: DocumentProcessingJobData) => Promise<void>) | null = null;

/**
 * Register the worker that processes document jobs.
 */
export function setDocumentProcessingHandler(fn: JobHandler): void {
  handler = fn;
}

/**
 * Add a document processing job. Returns when the job is enqueued (not when it finishes).
 */
export async function enqueueDocumentProcessing(data: DocumentProcessingJobData): Promise<void> {
  if (addToBull) {
    await addToBull(data);
    return;
  }
  // In-process: run in background so upload response returns immediately
  if (handler) {
    setImmediate(() => {
      handler!(data).catch((err) => {
        console.error("[queue] Document processing failed for", data.documentId, err);
      });
    });
  }
}

/**
 * Initialize queue. If REDIS_URL is set, use BullMQ; otherwise in-process only.
 */
export async function initQueue(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const { Queue } = await import("bullmq");
    const connection = { url: redisUrl };
    const queue = new Queue<DocumentProcessingJobData>("document-processing", {
      connection,
      defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 2000 } },
    });
    addToBull = async (data) => {
      await queue.add("process", data);
    };
    useBull = true;
    console.log("[queue] BullMQ connected (Redis)");
  } else {
    console.log("[queue] No REDIS_URL; using in-process queue");
  }
}

/**
 * Get the queue for worker (BullMQ). Returns null if using in-process only.
 */
export async function getDocumentProcessingQueue() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  const { Queue } = await import("bullmq");
  return new Queue<DocumentProcessingJobData>("document-processing", { connection: { url: redisUrl } });
}

// --- Phase 7: Production jobs ---

export type ProductionJobData = { productionId: string };

type ProductionJobHandler = (data: ProductionJobData) => Promise<void>;

let productionHandler: ProductionJobHandler | null = null;

export function setProductionJobHandler(fn: ProductionJobHandler): void {
  productionHandler = fn;
}

export async function enqueueProduction(data: ProductionJobData): Promise<void> {
  if (productionHandler) {
    setImmediate(() => {
      productionHandler!(data).catch((err) => {
        console.error("[queue] Production job failed for", data.productionId, err);
      });
    });
  }
}
