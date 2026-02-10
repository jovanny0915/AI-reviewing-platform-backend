/**
 * Phase 8: Inbound production import job.
 * Parse DAT/OPT, create documents and inbound_production_documents, preserve Bates.
 */

import { randomUUID } from "crypto";
import { createSupabaseClient } from "./supabase.js";
import { parseLoadFile } from "./loadfile-parser.js";

const supabase = createSupabaseClient();

export type RunImportParams = {
  inboundProductionId: string;
  datContent: string;
  optContent?: string | null;
  tiffBasePath: string;
  matterId?: string | null;
  datStoragePath?: string | null;
  optStoragePath?: string | null;
};

/**
 * Run import: parse DAT (use OPT if provided and has more records), create document rows and linkage.
 */
export async function runInboundImport(params: RunImportParams): Promise<{ documentCount: number; error?: string }> {
  const { inboundProductionId, datContent, optContent, tiffBasePath, matterId, datStoragePath, optStoragePath } = params;

  const datResult = parseLoadFile(datContent);
  if (datResult.errors.length > 0 && datResult.records.length === 0) {
    return { documentCount: 0, error: datResult.errors[0] };
  }
  let records = datResult.records;
  if (optContent && optContent.trim()) {
    const optResult = parseLoadFile(optContent);
    if (optResult.records.length > records.length) {
      records = optResult.records;
    }
  }

  const normTiffBase = tiffBasePath.replace(/\\/g, "/").replace(/\/?$/, "") + "/";
  let documentCount = 0;

  for (const rec of records) {
    try {
      const docId = randomUUID();
      const imagePath = rec.imagePath ? (rec.imagePath.startsWith("/") || /^[A-Za-z]:/.test(rec.imagePath) ? rec.imagePath : normTiffBase + rec.imagePath) : "";
      const storagePath = `inbound/${inboundProductionId}/${rec.begBates}`;
      const originalFilename = rec.nativePath?.split(/[/\\]/).pop() || `${rec.begBates}.tif`;

      const { error: docErr } = await supabase.from("documents").insert({
        id: docId,
        matter_id: matterId || null,
        parent_id: null,
        family_id: docId,
        family_index: 0,
        storage_path,
        filename: originalFilename,
        original_filename: originalFilename,
        mime_type: "image/tiff",
        file_type: "image/tiff",
        custodian: null,
        md5_hash: null,
        sha1_hash: null,
        size: 0,
        metadata: {
          bates_begin: rec.begBates,
          bates_end: rec.endBates,
          source: "inbound",
          inbound_production_id: inboundProductionId,
          image_path: imagePath || rec.imagePath,
          native_path: rec.nativePath,
        },
        extracted_text_path: null,
        processing_status: "ocr_complete",
        inbound_production_id: inboundProductionId,
      });

      if (docErr) {
        throw new Error(docErr.message);
      }

      const { error: linkErr } = await supabase.from("inbound_production_documents").insert({
        inbound_production_id: inboundProductionId,
        document_id: docId,
        bates_begin: rec.begBates,
        bates_end: rec.endBates,
        image_path: imagePath || rec.imagePath,
        native_path: rec.nativePath,
        page_count: rec.pageCount,
      });

      if (linkErr) {
        throw new Error(linkErr.message);
      }
      documentCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("inbound_productions")
        .update({ status: "failed", error_message: `Row ${rec.begBates}: ${msg}`, completed_at: new Date().toISOString() })
        .eq("id", inboundProductionId);
      return { documentCount, error: msg };
    }
  }

  await supabase
    .from("inbound_productions")
    .update({
      status: "complete",
      document_count: documentCount,
      error_message: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", inboundProductionId);

  return { documentCount };
}
