import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { createSignedUrl, downloadDocument } from "../lib/storage.js";
import { appendAuditLog } from "../lib/audit.js";
import { success, error } from "../lib/api-response.js";
import { enqueueDocumentProcessing } from "../lib/queue.js";

const router = Router();
const supabase = createSupabaseClient();

type ListFilters = {
  matterId?: string;
  custodian?: string;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  docType?: string;
  familyId?: string;
  folderId?: string;
  /** Phase 4: when filtering by folderId, restrict to these document IDs (from document_folders). */
  documentIdsInFolder?: string[] | null;
};

/**
 * Apply Phase 3/4 list filters to a Supabase query builder.
 * Supports: custodian, dateFrom, dateTo, keyword, docType, familyId; folder is applied via documentIdsInFolder.
 */
function applyListFilters<T>(query: T, filters: ListFilters): T {
  let q: unknown = query;
  const chain = q as { eq: (col: string, val: unknown) => unknown; gte: (col: string, val: unknown) => unknown; lte: (col: string, val: unknown) => unknown; or: (expr: string) => unknown; in: (col: string, val: unknown[]) => unknown };
  if (filters.matterId) q = chain.eq("matter_id", filters.matterId);
  if (filters.custodian) q = (q as typeof chain).eq("custodian", filters.custodian);
  if (filters.dateFrom) q = (q as typeof chain).gte("created_at", filters.dateFrom);
  if (filters.dateTo) q = (q as typeof chain).lte("created_at", filters.dateTo);
  if (filters.docType) q = (q as typeof chain).eq("file_type", filters.docType);
  if (filters.familyId) q = (q as typeof chain).eq("family_id", filters.familyId);
  if (filters.documentIdsInFolder != null && filters.documentIdsInFolder.length > 0) {
    q = (q as typeof chain).in("id", filters.documentIdsInFolder);
  }
  if (filters.keyword?.trim()) {
    const term = filters.keyword.trim().replace(/,/g, " ");
    const k = `%${term}%`;
    q = (q as typeof chain).or(`original_filename.ilike.${k},filename.ilike.${k},custodian.ilike.${k}`);
  }
  return q as T;
}

/** Phase 4: Get folder ID and all descendant folder IDs when includeSubfolders is true. */
async function getFolderIdsForFilter(
  folderId: string,
  includeSubfolders: boolean
): Promise<string[]> {
  if (!includeSubfolders) return [folderId];
  const { data: allFolders } = await supabase.from("folders").select("id, parent_id");
  const rows = (allFolders ?? []) as { id: string; parent_id: string | null }[];
  const byParent = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.parent_id ?? "";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(r.id);
  }
  const result: string[] = [];
  const stack: string[] = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    for (const childId of byParent.get(id) ?? []) {
      stack.push(childId);
    }
  }
  return result;
}

/** Phase 4: Get document IDs that are in any of the given folders. */
async function getDocumentIdsInFolders(folderIds: string[]): Promise<string[]> {
  if (folderIds.length === 0) return [];
  const { data } = await supabase
    .from("document_folders")
    .select("document_id")
    .in("folder_id", folderIds);
  const ids = [...new Set((data ?? []).map((r: { document_id: string }) => r.document_id))];
  return ids;
}

/**
 * GET /api/documents
 * List documents with optional pagination and filters (Phase 3).
 * Query: matter_id, custodian, dateFrom, dateTo, keyword, docType, familyId, folderId, page, pageSize.
 * expand=families: return family groups (parent + children) for grid; only root docs counted in pagination.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
    const matterId = req.query.matter_id as string | undefined;
    const familyId = req.query.family_id as string | undefined;
    const custodian = req.query.custodian as string | undefined;
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;
    const keyword = req.query.keyword as string | undefined;
    const docType = req.query.docType as string | undefined;
    const folderId = req.query.folderId as string | undefined;
    const includeSubfolders = (req.query.includeSubfolders as string) === "true";
    const expandFamilies = (req.query.expand as string) === "families";
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let documentIdsInFolder: string[] | null = null;
    if (folderId) {
      const folderIds = await getFolderIdsForFilter(folderId, includeSubfolders);
      const docIds = await getDocumentIdsInFolders(folderIds);
      if (docIds.length === 0) {
        if (expandFamilies) {
          return success(res, { familyGroups: [], total: 0, page, pageSize });
        }
        return success(res, { documents: [], total: 0, page, pageSize });
      }
      documentIdsInFolder = docIds;
    }

    const filters = {
      matterId,
      custodian,
      dateFrom,
      dateTo,
      keyword,
      docType,
      familyId,
      folderId,
      documentIdsInFolder,
    };

    if (expandFamilies) {
      // Return family groups: roots only, with children nested. Order by root created_at desc.
      let rootsQuery = supabase
        .from("documents")
        .select("*", { count: "exact" })
        .is("parent_id", null)
        .order("created_at", { ascending: false })
        .range(from, to);
      rootsQuery = applyListFilters(rootsQuery, filters);

      const { data: roots, error: rootsErr, count: totalCount } = await rootsQuery;
      if (rootsErr) {
        const code = (rootsErr as { code?: string }).code ?? "DB_ERROR";
        return error(res, rootsErr.message, 500, code);
      }

      const familyIds = [...new Set((roots ?? []).map((r: { family_id?: string; id: string }) => r.family_id ?? r.id))];
      const { data: childrenRows } = await supabase
        .from("documents")
        .select("*")
        .not("parent_id", "is", null)
        .in("family_id", familyIds)
        .order("family_index", { ascending: true });

      const childrenByFamily = new Map<string, typeof childrenRows>();
      for (const c of childrenRows ?? []) {
        const fid = (c as { family_id?: string }).family_id ?? "";
        if (!childrenByFamily.has(fid)) childrenByFamily.set(fid, []);
        childrenByFamily.get(fid)!.push(c);
      }

      const familyGroups = (roots ?? []).map((root: { family_id?: string; id: string }) => ({
        id: (root as { family_id?: string }).family_id ?? root.id,
        parent: root,
        children: childrenByFamily.get((root as { family_id?: string }).family_id ?? root.id) ?? [],
      }));

      return success(res, {
        familyGroups,
        total: totalCount ?? familyGroups.length,
        page,
        pageSize,
      });
    }

    let query = supabase
      .from("documents")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    query = applyListFilters(query, filters);

    const { data, error: dbError, count: totalCount } = await query;

    if (dbError) {
      const code = (dbError as { code?: string }).code ?? "DB_ERROR";
      return error(res, dbError.message, 500, code);
    }

    return success(res, {
      documents: data ?? [],
      total: totalCount ?? data?.length ?? 0,
      page,
      pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * PATCH /api/documents/:id/coding
 * Phase 3.4: Set relevance_flag, privilege_flag, issue_tags; store reviewer_id, coding_timestamp; write to audit_log.
 */
router.patch("/:id/coding", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as Request & { userId?: string }).userId ?? null;
    const body = req.body as {
      relevance_flag?: boolean | null;
      privilege_flag?: boolean | null;
      issue_tags?: string[] | null;
    };

    const updates: Record<string, unknown> = {
      reviewer_id: userId,
      coding_timestamp: new Date().toISOString(),
    };
    if (body.relevance_flag !== undefined) updates.relevance_flag = body.relevance_flag;
    if (body.privilege_flag !== undefined) updates.privilege_flag = body.privilege_flag;
    if (body.issue_tags !== undefined) updates.issue_tags = body.issue_tags ?? [];

    const { data: doc, error: updateErr } = await supabase
      .from("documents")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) {
      const code = (updateErr as { code?: string }).code ?? "DB_ERROR";
      return error(res, updateErr.message, 500, code);
    }
    if (!doc) {
      return error(res, "Document not found", 404, "NOT_FOUND");
    }

    await appendAuditLog({
      user_id: userId,
      document_id: id,
      action_type: "tag",
      metadata_snapshot: {
        relevance_flag: doc.relevance_flag,
        privilege_flag: doc.privilege_flag,
        issue_tags: doc.issue_tags,
        coding_timestamp: doc.coding_timestamp,
      },
    });

    return success(res, doc);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/documents/:id/extracted-text
 * Return the OCR/extracted text for the document (from storage). 404 if none.
 */
router.get("/:id/extracted-text", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .select("extracted_text_path")
      .eq("id", id)
      .single();
    if (dbError || !doc?.extracted_text_path) {
      return res.status(404).json({ success: false, error: "No extracted text" });
    }
    const { buffer, error: downloadErr } = await downloadDocument(doc.extracted_text_path);
    if (downloadErr || !buffer.length) {
      return error(res, downloadErr ?? "Failed to load extracted text", 500, "STORAGE_ERROR");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(buffer.toString("utf-8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/documents/:id/process
 * Enqueue metadata extraction + OCR for this document. Returns immediately (202).
 * Used when upload was done elsewhere (e.g. Next.js) so processing still runs.
 */
router.post("/:id/process", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const forceOcr = (req.body?.force_ocr === true) || (req.query.force_ocr === "true");
    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .select("id")
      .eq("id", id)
      .single();
    if (dbError || !doc) {
      return error(res, "Document not found", 404, "NOT_FOUND");
    }
    await enqueueDocumentProcessing({ documentId: id, forceOcr });
    return res.status(202).json({ success: true, message: "Processing enqueued", documentId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/documents/:id
 * Fetch a single document by ID, optionally with signed URL and expand=family (parent + children).
 * Logs a "view" event to audit_log.
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const includeUrl = req.query.signedUrl === "true";
    const expandFamily = (req.query.expand as string) === "family";
    const userId = (req as Request & { userId?: string }).userId ?? null;

    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", id)
      .single();

    if (dbError || !doc) {
      return error(res, dbError?.message ?? "Document not found", 404, "NOT_FOUND");
    }

    await appendAuditLog({
      user_id: userId,
      document_id: id,
      action_type: "view",
      metadata_snapshot: { document_id: id },
    });

    let signedUrl: string | null = null;
    if (includeUrl && doc.storage_path) {
      const { url } = await createSignedUrl(doc.storage_path);
      signedUrl = url;
    }

    const payload: Record<string, unknown> = { ...doc, signedUrl };

    if (expandFamily) {
      const familyId = (doc as { family_id?: string }).family_id ?? doc.id;
      let parent = null;
      if ((doc as { parent_id?: string }).parent_id) {
        const { data: p } = await supabase.from("documents").select("*").eq("id", (doc as { parent_id: string }).parent_id).single();
        parent = p;
      }
      const { data: children } = await supabase
        .from("documents")
        .select("*")
        .eq("family_id", familyId)
        .not("parent_id", "is", null)
        .order("family_index", { ascending: true });
      payload.parent = parent;
      payload.children = children ?? [];
    }

    return success(res, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
