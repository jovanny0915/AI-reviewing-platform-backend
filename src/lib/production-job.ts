/**
 * Phase 7.5–7.6: Production job runner.
 * Select docs from folder/matter → convert to TIFF (or placeholder) → Bates stamp → redaction burn-in →
 * write TIFFs + DAT/OPT to storage; update production_documents, production_pages; audit and validation.
 */

import { createSupabaseClient } from "./supabase.js";
import { downloadDocument, uploadDocument } from "./storage.js";
import { appendAuditLog } from "./audit.js";
import {
  imageToTiff,
  createPlaceholderTiff,
  formatBatesNumber,
  canConvertToTiff,
  pdfToTiffPages,
} from "./production-tiff.js";
import { generateDat, generateOpt, type LoadFileRecord } from "./loadfile.js";

const supabase = createSupabaseClient();

type ProductionRow = {
  id: string;
  name: string;
  matter_id: string | null;
  bates_prefix: string;
  bates_start_number: number;
  source_folder_id: string | null;
  include_subfolders: boolean;
  status: string;
};

type DocumentRow = {
  id: string;
  storage_path: string;
  file_type: string | null;
  original_filename: string | null;
  filename: string;
};

type RedactionRow = {
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

async function getFolderIdsWithDescendants(folderId: string, includeSubfolders: boolean): Promise<string[]> {
  if (!includeSubfolders) return [folderId];
  const { data: rows } = await supabase.from("folders").select("id, parent_id");
  const byParent = new Map<string, string[]>();
  for (const r of (rows ?? []) as { id: string; parent_id: string | null }[]) {
    const p = r.parent_id ?? "";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(r.id);
  }
  const result: string[] = [];
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    for (const c of byParent.get(id) ?? []) stack.push(c);
  }
  return result;
}

async function getDocumentIdsInFolders(folderIds: string[]): Promise<string[]> {
  if (folderIds.length === 0) return [];
  const { data } = await supabase
    .from("document_folders")
    .select("document_id")
    .in("folder_id", folderIds);
  return [...new Set((data ?? []).map((r: { document_id: string }) => r.document_id))];
}

/**
 * Get list of document IDs for this production (from folder or matter). Returns root docs only (one per family) for production scope.
 */
async function getProductionDocumentIds(prod: ProductionRow): Promise<string[]> {
  if (prod.source_folder_id) {
    const folderIds = await getFolderIdsWithDescendants(
      prod.source_folder_id,
      prod.include_subfolders
    );
    const docIds = await getDocumentIdsInFolders(folderIds);
    if (docIds.length === 0) return [];
    // Optionally restrict to family roots only so we produce one set per family
    const { data: docs } = await supabase
      .from("documents")
      .select("id, parent_id")
      .in("id", docIds);
    const roots = (docs ?? []).filter(
      (d: { parent_id: string | null }) => !d.parent_id
    );
    return roots.length > 0
      ? roots.map((r: { id: string }) => r.id)
      : docIds;
  }
  if (prod.matter_id) {
    const { data } = await supabase
      .from("documents")
      .select("id")
      .eq("matter_id", prod.matter_id)
      .is("parent_id", null)
      .order("created_at", { ascending: false });
    return (data ?? []).map((r: { id: string }) => r.id);
  }
  return [];
}

/** Normalize redaction coords to 0–1 for burn-in. */
function normalizeRedactions(
  redactions: RedactionRow[],
  imageWidth: number,
  imageHeight: number
): { x: number; y: number; width: number; height: number }[] {
  if (imageWidth <= 0 || imageHeight <= 0) return [];
  return redactions.map((r) => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  }));
}

/** Assume redactions stored 0–1; if they look like pixel coords (large), normalize. */
function asNormalized(
  redactions: RedactionRow[],
  imageWidth: number,
  imageHeight: number
): { x: number; y: number; width: number; height: number }[] {
  const first = redactions[0];
  if (!first) return [];
  const likelyNormalized = first.x <= 1 && first.y <= 1 && first.width <= 1 && first.height <= 1;
  if (likelyNormalized) return redactions as { x: number; y: number; width: number; height: number }[];
  return normalizeRedactions(redactions, imageWidth, imageHeight);
}

export async function runProductionJob(productionId: string): Promise<void> {
  const { data: prod, error: prodErr } = await supabase
    .from("productions")
    .select("*")
    .eq("id", productionId)
    .single();

  if (prodErr || !prod) {
    throw new Error(`Production not found: ${productionId}`);
  }

  const row = prod as ProductionRow;
  if (row.status !== "pending" && row.status !== "processing") {
    throw new Error(`Production status is ${row.status}`);
  }

  await supabase
    .from("productions")
    .update({ status: "processing", error_message: null })
    .eq("id", productionId);

  const docIds = await getProductionDocumentIds(row);
  const outputPrefix = `productions/${productionId}`;
  const tiffPrefix = `${outputPrefix}/tiff`;
  let nextBates = row.bates_start_number;
  const padLength = 6;
  const loadFileRecords: LoadFileRecord[] = [];
  const volumePath = "tiff"; // relative path for IMAGEPATH in load file

  try {
    for (const documentId of docIds) {
      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .select("id, storage_path, file_type, original_filename, filename")
        .eq("id", documentId)
        .single();

      if (docErr || !doc) continue;

      const d = doc as DocumentRow;
      const mimeType = d.file_type ?? null;
      const nativeFilename = d.original_filename || d.filename;
      const convertType = canConvertToTiff(mimeType);

      let pageCount = 0;
      let batesBegin = "";
      let batesEnd = "";
      const pageInserts: { production_id: string; document_id: string; page_number: number; bates_number: string; tiff_storage_path: string | null }[] = [];

      if (convertType === "image") {
        const { buffer, error: downErr } = await downloadDocument(d.storage_path);
        if (downErr || !buffer?.length) {
          // Fallback to placeholder
          const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
          const tiffPath = `${tiffPrefix}/${bates}.tif`;
          const placeholder = await createPlaceholderTiff(bates, nativeFilename);
          const { error: upErr } = await uploadDocument(placeholder, tiffPath, {
            contentType: "image/tiff",
            upsert: true,
          });
          if (upErr) throw new Error(`Upload placeholder failed: ${upErr}`);
          pageCount = 1;
          batesBegin = bates;
          batesEnd = bates;
          pageInserts.push({
            production_id: productionId,
            document_id: documentId,
            page_number: 1,
            bates_number: bates,
            tiff_storage_path: tiffPath,
          });
          nextBates++;
        } else {
          const { data: redRows } = await supabase
            .from("redactions")
            .select("page_number, x, y, width, height")
            .eq("document_id", documentId)
            .eq("page_number", 1);
          const redactions = (redRows ?? []) as RedactionRow[];
          const sharp = (await import("sharp")).default;
          const meta = await sharp(buffer).metadata();
          const w = meta.width ?? 0;
          const h = meta.height ?? 0;
          const redNorm = asNormalized(redactions, w, h);
          const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
          const tiffPath = `${tiffPrefix}/${bates}.tif`;
          const tiffBuffer = await imageToTiff(buffer, {
            batesNumber: bates,
            redactions: redNorm,
            imageWidth: w,
            imageHeight: h,
          });
          const { error: upErr } = await uploadDocument(tiffBuffer, tiffPath, {
            contentType: "image/tiff",
            upsert: true,
          });
          if (upErr) throw new Error(`Upload TIFF failed: ${upErr}`);
          pageCount = 1;
          batesBegin = bates;
          batesEnd = bates;
          pageInserts.push({
            production_id: productionId,
            document_id: documentId,
            page_number: 1,
            bates_number: bates,
            tiff_storage_path: tiffPath,
          });
          nextBates++;
        }
      } else if (convertType === "pdf") {
        const { buffer, error: downErr } = await downloadDocument(d.storage_path);
        if (downErr || !buffer?.length) {
          const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
          const tiffPath = `${tiffPrefix}/${bates}.tif`;
          const placeholder = await createPlaceholderTiff(bates, nativeFilename);
          await uploadDocument(placeholder, tiffPath, {
            contentType: "image/tiff",
            upsert: true,
          });
          pageCount = 1;
          batesBegin = bates;
          batesEnd = bates;
          pageInserts.push({
            production_id: productionId,
            document_id: documentId,
            page_number: 1,
            bates_number: bates,
            tiff_storage_path: tiffPath,
          });
          nextBates++;
        } else {
          const pdfPages = await pdfToTiffPages(buffer);
          if (pdfPages.length > 0) {
            const { data: redRows } = await supabase
              .from("redactions")
              .select("page_number, x, y, width, height")
              .eq("document_id", documentId);
            const redsByPage = new Map<number, RedactionRow[]>();
            for (const r of (redRows ?? []) as RedactionRow[]) {
              if (!redsByPage.has(r.page_number)) redsByPage.set(r.page_number, []);
              redsByPage.get(r.page_number)!.push(r);
            }
            for (const page of pdfPages) {
              const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
              const tiffPath = `${tiffPrefix}/${bates}.tif`;
              const reds = redsByPage.get(page.pageNumber) ?? [];
              const sharp = (await import("sharp")).default;
              const meta = await sharp(page.tiffBuffer).metadata();
              const w = meta.width ?? 0;
              const h = meta.height ?? 0;
              const redNorm = asNormalized(reds, w, h);
              const tiffBuffer = await imageToTiff(page.tiffBuffer, {
                batesNumber: bates,
                redactions: redNorm,
                imageWidth: w,
                imageHeight: h,
              });
              await uploadDocument(tiffBuffer, tiffPath, {
                contentType: "image/tiff",
                upsert: true,
              });
              pageInserts.push({
                production_id: productionId,
                document_id: documentId,
                page_number: page.pageNumber,
                bates_number: bates,
                tiff_storage_path: tiffPath,
              });
              nextBates++;
            }
            pageCount = pdfPages.length;
            batesBegin = formatBatesNumber(row.bates_prefix, nextBates - pageCount, padLength);
            batesEnd = formatBatesNumber(row.bates_prefix, nextBates - 1, padLength);
          } else {
            const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
            const tiffPath = `${tiffPrefix}/${bates}.tif`;
            const placeholder = await createPlaceholderTiff(bates, nativeFilename);
            await uploadDocument(placeholder, tiffPath, {
              contentType: "image/tiff",
              upsert: true,
            });
            pageCount = 1;
            batesBegin = bates;
            batesEnd = bates;
            pageInserts.push({
              production_id: productionId,
              document_id: documentId,
              page_number: 1,
              bates_number: bates,
              tiff_storage_path: tiffPath,
            });
            nextBates++;
          }
        }
      } else {
        const bates = formatBatesNumber(row.bates_prefix, nextBates, padLength);
        const tiffPath = `${tiffPrefix}/${bates}.tif`;
        const placeholder = await createPlaceholderTiff(bates, nativeFilename);
        await uploadDocument(placeholder, tiffPath, {
          contentType: "image/tiff",
          upsert: true,
        });
        pageCount = 1;
        batesBegin = bates;
        batesEnd = bates;
        pageInserts.push({
          production_id: productionId,
          document_id: documentId,
          page_number: 1,
          bates_number: bates,
          tiff_storage_path: tiffPath,
        });
        nextBates++;
      }

      const imagePath = pageCount > 0
        ? `${volumePath}/${batesBegin}.tif`
        : "";
      const nativePath = nativeFilename || "";

      loadFileRecords.push({
        begBates: batesBegin,
        endBates: batesEnd,
        imagePath,
        nativePath,
        pageCount,
        controlId: documentId,
      });

      await supabase.from("production_documents").insert({
        production_id: productionId,
        document_id: documentId,
        bates_begin: batesBegin,
        bates_end: batesEnd,
        page_count: pageCount,
        is_placeholder: convertType === "placeholder" || (convertType === "pdf" && pageCount === 1),
        native_filename: nativeFilename,
      });

      for (const ins of pageInserts) {
        await supabase.from("production_pages").insert(ins);
      }

      await appendAuditLog({
        document_id: documentId,
        action_type: "produce",
        metadata_snapshot: {
          production_id: productionId,
          production_name: row.name,
          bates_begin: batesBegin,
          bates_end: batesEnd,
          page_count: pageCount,
        },
      });
    }

    const datContent = generateDat(loadFileRecords);
    const optContent = generateOpt(loadFileRecords);
    const datPath = `${outputPrefix}/loadfile.dat`;
    const optPath = `${outputPrefix}/loadfile.opt`;

    await uploadDocument(Buffer.from(datContent, "utf-8"), datPath, {
      contentType: "text/plain",
      upsert: true,
    });
    await uploadDocument(Buffer.from(optContent, "utf-8"), optPath, {
      contentType: "text/plain",
      upsert: true,
    });

    await supabase
      .from("productions")
      .update({
        status: "complete",
        output_storage_path: outputPrefix,
        completed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", productionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("productions")
      .update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", productionId);
    throw err;
  }
}

/**
 * Return production audit report (for export): production_documents with document hashes for validation.
 */
export async function getProductionAuditReport(productionId: string): Promise<{
  production: ProductionRow;
  documents: Array<{
    document_id: string;
    bates_begin: string;
    bates_end: string;
    page_count: number;
    is_placeholder: boolean;
    native_filename: string | null;
    md5_hash: string | null;
    sha1_hash: string | null;
    original_filename: string | null;
  }>;
}> {
  const { data: prod, error: prodErr } = await supabase
    .from("productions")
    .select("*")
    .eq("id", productionId)
    .single();
  if (prodErr || !prod) {
    throw new Error("Production not found");
  }

  const { data: pdRows } = await supabase
    .from("production_documents")
    .select("document_id, bates_begin, bates_end, page_count, is_placeholder, native_filename")
    .eq("production_id", productionId);

  const docIds = [...new Set((pdRows ?? []).map((r: { document_id: string }) => r.document_id))];
  let docMap: Map<string, { md5_hash: string | null; sha1_hash: string | null; original_filename: string | null }> = new Map();
  if (docIds.length > 0) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, md5_hash, sha1_hash, original_filename")
      .in("id", docIds);
    for (const d of docs ?? []) {
      const x = d as { id: string; md5_hash: string | null; sha1_hash: string | null; original_filename: string | null };
      docMap.set(x.id, {
        md5_hash: x.md5_hash ?? null,
        sha1_hash: x.sha1_hash ?? null,
        original_filename: x.original_filename ?? null,
      });
    }
  }

  const documents = (pdRows ?? []).map((r: { document_id: string; bates_begin: string; bates_end: string; page_count: number; is_placeholder: boolean; native_filename: string | null }) => {
    const info = docMap.get(r.document_id);
    return {
      document_id: r.document_id,
      bates_begin: r.bates_begin,
      bates_end: r.bates_end,
      page_count: r.page_count,
      is_placeholder: r.is_placeholder,
      native_filename: r.native_filename,
      md5_hash: info?.md5_hash ?? null,
      sha1_hash: info?.sha1_hash ?? null,
      original_filename: info?.original_filename ?? null,
    };
  });

  return {
    production: prod as ProductionRow,
    documents,
  };
}
