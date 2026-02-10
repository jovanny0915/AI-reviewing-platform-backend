import "dotenv/config";
import { lookup } from "node:dns/promises";
import express from "express";
import cors from "cors";
import { optionalAuthMiddleware } from "./lib/auth.js";
import { initQueue, setDocumentProcessingHandler } from "./lib/queue.js";
import { processDocument, setDocumentFailed } from "./lib/document-processor.js";
import documentsRouter from "./routes/documents.js";
import uploadRouter from "./routes/upload.js";
import savedSearchesRouter from "./routes/saved-searches.js";
import foldersRouter from "./routes/folders.js";
import searchRouter from "./routes/search.js";
import redactionsRouter from "./routes/redactions.js";
import productionsRouter from "./routes/productions.js";
import aiRouter from "./routes/ai.js";
import { setProductionJobHandler } from "./lib/queue.js";
import { runProductionJob } from "./lib/production-job.js";

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:4000";

// Validate required env
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env"
  );
  process.exit(1);
}

// Warn if Supabase URL resolves to a private IP (common cause of ETIMEDOUT)
const supabaseUrl = process.env.SUPABASE_URL!;
try {
  const supabaseHost = new URL(supabaseUrl).hostname;
  const resolved = await lookup(supabaseHost, { all: false });
  const ip = resolved?.address ?? "";
  const isPrivate =
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip);
  if (isPrivate) {
    console.error(
      `[Supabase] SUPABASE_URL host "${supabaseHost}" resolves to private IP ${ip}. ` +
        "Supabase uses public IPs. Fix: use a network/DNS that does not redirect *.supabase.co to a private IP (e.g. disable VPN, use different DNS like 8.8.8.8, or whitelist Supabase)."
    );
    process.exit(1);
  }
} catch (e) {
  console.warn("[Supabase] Could not resolve SUPABASE_URL host:", (e as Error).message);
}

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Optional auth: set req.userId when Bearer JWT is valid (Phase 0.5)
app.use(optionalAuthMiddleware);

// API routes
app.use("/api/documents", documentsRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/saved-searches", savedSearchesRouter);
app.use("/api/folders", foldersRouter);
app.use("/api/search", searchRouter);
app.use("/api/redactions", redactionsRouter);
app.use("/api/productions", productionsRouter);
app.use("/api/ai", aiRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "document-processing-api" });
});

// Phase 1.4: Init queue and in-process handler (when not using Redis worker)
async function start() {
  await initQueue();
  setDocumentProcessingHandler(async (data) => {
    try {
      await processDocument({ documentId: data.documentId, forceOcr: data.forceOcr });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[queue] Document processing failed for", data.documentId, msg);
      await setDocumentFailed(data.documentId, msg);
    }
  });
  setProductionJobHandler(async (data) => {
    try {
      await runProductionJob(data.productionId);
    } catch (err) {
      console.error("[queue] Production job failed for", data.productionId, err);
    }
  });
  app.listen(PORT, () => {
    console.log(`API server running at http://localhost:${PORT}`);
  });
}
start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
