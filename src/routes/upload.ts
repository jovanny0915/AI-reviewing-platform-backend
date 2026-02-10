import { Router, Request, Response } from "express";
import multer from "multer";
import { randomUUID, createHash } from "crypto";
import { createSupabaseClient } from "../lib/supabase.js";
import { uploadDocument } from "../lib/storage.js";
import { appendAuditLog } from "../lib/audit.js";
import { success, error } from "../lib/api-response.js";
import { enqueueDocumentProcessing } from "../lib/queue.js";

const router = Router();
const supabase = createSupabaseClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

function computeHashes(buffer: Buffer): { md5: string; sha1: string } {
  return {
    md5: createHash("md5").update(buffer).digest("hex"),
    sha1: createHash("sha1").update(buffer).digest("hex"),
  };
}

/**
 * POST /api/upload
 * Accept multipart file upload; save to storage, compute hashes, create documents row (Phase 1.1).
 * Enqueue background job for metadata extraction and OCR (Phase 1.4). Upload returns immediately.
 * Body/query: matter_id (optional), custodian (optional), force_ocr (optional).
 */
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return error(res, "No file provided or invalid file", 400, "MISSING_FILE");
    }

    const matterId = (req.body.matter_id as string) || (req.query.matter_id as string) || null;
    const custodian = (req.body.custodian as string) || (req.query.custodian as string) || null;
    const forceOcr = (req.body.force_ocr as string) === "true" || (req.query.force_ocr as string) === "true";
    const userId = (req as Request & { userId?: string }).userId ?? null;

    const id = randomUUID();
    const filename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${id}/${filename}`;

    const { path: uploadedPath, error: uploadErr } = await uploadDocument(
      file.buffer,
      storagePath,
      { contentType: file.mimetype }
    );

    if (uploadErr || !uploadedPath) {
      return error(res, uploadErr ?? "Upload failed", 500, "UPLOAD_ERROR");
    }

    const { md5: md5_hash, sha1: sha1_hash } = computeHashes(file.buffer);

    const { data: doc, error: insertErr } = await supabase
      .from("documents")
      .insert({
        id,
        matter_id: matterId || null,
        parent_id: null,
        family_id: id,
        family_index: 0,
        storage_path: storagePath,
        filename: file.originalname,
        original_filename: file.originalname,
        mime_type: file.mimetype || null,
        file_type: file.mimetype || null,
        custodian: custodian || null,
        md5_hash,
        sha1_hash,
        size: file.size,
        metadata: {},
        extracted_text_path: null,
        processing_status: "pending",
      })
      .select()
      .single();

    if (insertErr) {
      return error(res, insertErr.message, 500, "DB_ERROR");
    }

    await appendAuditLog({
      user_id: userId,
      document_id: id,
      action_type: "upload",
      metadata_snapshot: { storage_path: storagePath, original_filename: file.originalname, matter_id: matterId },
    });

    await enqueueDocumentProcessing({ documentId: id, forceOcr });

    return success(res, { id: doc.id, document: doc }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
