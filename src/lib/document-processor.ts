/**
 * Phase 1: Single place that runs metadata extraction + OCR for a document.
 * Phase 2: On email (MSG/EML), parse and create child documents for attachments; link family.
 */

import { randomUUID, createHash } from "crypto";
import { createSupabaseClient } from "./supabase.js";
import { downloadDocument, uploadDocument } from "./storage.js";
import { extractMetadata } from "./metadata.js";
import { needsOcr, runTesseract } from "./ocr.js";
import { isEmailFile, parseEmail } from "./email-parser.js";
import { appendAuditLog } from "./audit.js";
import { enqueueDocumentProcessing } from "./queue.js";

const supabase = createSupabaseClient();

export type ProcessDocumentOptions = {
  documentId: string;
  forceOcr?: boolean;
};

function computeHashes(buffer: Buffer): { md5: string; sha1: string } {
  return {
    md5: createHash("md5").update(buffer).digest("hex"),
    sha1: createHash("sha1").update(buffer).digest("hex"),
  };
}

/**
 * Phase 2.3: When document is an email, parse and create child records for each attachment.
 * Each attachment is stored and gets its own document row with same family_id, parent_id = this doc.
 */
async function linkEmailAttachments(
  parentId: string,
  familyId: string,
  buffer: Buffer,
  mimeType: string | null,
  filename: string,
  matterId: string | null,
  custodian: string | null
): Promise<void> {
  const parsed = await parseEmail(buffer, { mimeType, filename });
  if (!parsed.isEmail || !parsed.attachments?.length) return;

  for (let i = 0; i < parsed.attachments.length; i++) {
    const att = parsed.attachments[i];
    const childId = randomUUID();
    const safeName = (att.filename || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${childId}/${safeName}`;

    const { path: uploadedPath, error: uploadErr } = await uploadDocument(att.content, storagePath, {
      contentType: att.contentType,
    });
    if (uploadErr) {
      console.warn("[document-processor] Failed to store email attachment:", att.filename, uploadErr);
      continue;
    }

    const { md5: md5_hash, sha1: sha1_hash } = computeHashes(att.content);

    const { error: insertErr } = await supabase.from("documents").insert({
      id: childId,
      matter_id: matterId,
      parent_id: parentId,
      family_id: familyId,
      family_index: i + 1,
      storage_path: storagePath,
      filename: att.filename || safeName,
      original_filename: att.filename || safeName,
      mime_type: att.contentType || null,
      file_type: att.contentType || null,
      custodian,
      md5_hash,
      sha1_hash,
      size: att.content.length,
      metadata: { source: "email_attachment", parent_document_id: parentId },
      extracted_text_path: null,
      processing_status: "pending",
    });

    if (insertErr) {
      console.warn("[document-processor] Failed to create child document:", insertErr.message);
      continue;
    }

    await appendAuditLog({
      document_id: childId,
      action_type: "upload",
      metadata_snapshot: { source: "email_attachment", parent_id: parentId, original_filename: att.filename },
    });

    await enqueueDocumentProcessing({ documentId: childId });
  }
}

/**
 * Process one document: metadata extraction, then OCR if needed.
 * For emails (MSG/EML): create child documents for attachments first, then process parent.
 */
export async function processDocument(options: ProcessDocumentOptions): Promise<void> {
  const { documentId, forceOcr = false } = options;

  const { data: doc, error: fetchErr } = await supabase
    .from("documents")
    .select("id, storage_path, file_type, original_filename, filename, extracted_text_path, processing_status, matter_id, custodian, family_id, metadata")
    .eq("id", documentId)
    .single();

  if (fetchErr || !doc) {
    throw new Error(fetchErr?.message ?? "Document not found");
  }

  // Phase 1.3: Cache - skip re-processing if we already have extracted text and not forced
  if (!forceOcr && doc.extracted_text_path && doc.processing_status === "ocr_complete") {
    return;
  }

  await supabase
    .from("documents")
    .update({ processing_status: "processing", processing_error: null })
    .eq("id", documentId);

  let metadata: Record<string, unknown> = (doc.metadata as Record<string, unknown>) ?? {};
  let extractedText: string | null = null;

  const { buffer, error: downloadErr } = await downloadDocument(doc.storage_path);
  if (downloadErr || !buffer.length) {
    await setFailed(documentId, downloadErr ?? "Download failed");
    return;
  }

  const filename = doc.original_filename ?? doc.filename ?? "";
  const mimeType = doc.file_type ?? null;

  // Phase 2.2–2.3: If email, parse and create child documents for attachments (once).
  const alreadyLinked = metadata?.email_children_linked === true;
  if (isEmailFile(mimeType, filename) && !alreadyLinked) {
    const familyId = (doc.family_id as string) || doc.id;
    await linkEmailAttachments(
      doc.id,
      familyId,
      buffer,
      mimeType,
      filename,
      doc.matter_id ?? null,
      doc.custodian ?? null
    );
    const parsed = await parseEmail(buffer, { mimeType, filename });
    if (parsed.isEmail) {
      if (parsed.parseError) {
        metadata = { ...metadata, email_parse_error: parsed.parseError };
      } else {
        metadata = {
          ...metadata,
          email_children_linked: true,
          email_subject: parsed.subject,
          email_from: parsed.from,
          email_to: parsed.to,
          email_date: parsed.date?.toISOString(),
        };
        if (parsed.text?.trim()) extractedText = parsed.text;
      }
    }
  } else if (isEmailFile(mimeType, filename)) {
    // Email already linked (reprocess): still extract body text for this run
    const parsed = await parseEmail(buffer, { mimeType, filename });
    if (parsed.isEmail && !parsed.parseError && parsed.text?.trim()) extractedText = parsed.text;
    if (parsed.isEmail && parsed.parseError) {
      metadata = { ...metadata, email_parse_error: parsed.parseError };
    }
  }

  try {
    const extracted = await extractMetadata(buffer, { mimeType, filename });
    metadata = { ...metadata, ...(extracted.metadata ?? {}) };
    if (extracted.text?.trim() && !extractedText) extractedText = extracted.text;
  } catch (e) {
    if (!metadata.extraction_error) {
      metadata.extraction_error = (e as Error).message;
    }
    console.warn("[document-processor] Metadata extraction error:", (e as Error).message);
  }

  await supabase
    .from("documents")
    .update({
      metadata,
      processing_status: "metadata_extracted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);

  const shouldRunOcr =
    forceOcr ||
    needsOcr(mimeType, filename, !!extractedText?.trim());

  if (shouldRunOcr && !extractedText?.trim()) {
    try {
      const ocrResult = await runTesseract(buffer);
      const text = ocrResult.text?.trim() ?? "";
      if (text) {
        extractedText = text;
        const textPath = `${documentId}/extracted.txt`;
        const { error: uploadTextErr } = await uploadDocument(Buffer.from(text, "utf-8"), textPath, {
          contentType: "text/plain",
        });
        if (!uploadTextErr) {
          await supabase
            .from("documents")
            .update({
              extracted_text_path: textPath,
              extracted_text: extractedText,
              processing_status: "ocr_complete",
              processed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        } else {
          await supabase
            .from("documents")
            .update({
              processing_status: "metadata_extracted",
              processing_error: "Failed to store extracted text",
              updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        }
      } else {
        await supabase
          .from("documents")
          .update({
            processing_status: "ocr_complete",
            processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", documentId);
      }
    } catch (e) {
      await setFailed(documentId, (e as Error).message);
    }
  } else {
    if (extractedText) {
      const textPath = `${documentId}/extracted.txt`;
      const { error: uploadTextErr } = await uploadDocument(Buffer.from(extractedText, "utf-8"), textPath, {
        contentType: "text/plain",
      });
      if (!uploadTextErr) {
        await supabase
          .from("documents")
          .update({
            extracted_text_path: textPath,
            extracted_text: extractedText,
            processing_status: "ocr_complete",
            processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", documentId);
      }
    } else {
      await supabase
        .from("documents")
        .update({
          processing_status: "ocr_complete",
          processed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
    }
  }
}

/** Mark document as failed (exported so queue can call on job throw). */
export async function setDocumentFailed(documentId: string, message: string): Promise<void> {
  await supabase
    .from("documents")
    .update({
      processing_status: "failed",
      processing_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);
}

async function setFailed(documentId: string, message: string): Promise<void> {
  await setDocumentFailed(documentId, message);
}
