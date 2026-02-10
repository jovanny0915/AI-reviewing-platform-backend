import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { success, error } from "../lib/api-response.js";

const router = Router();
const supabase = createSupabaseClient();

export type FolderRow = {
  id: string;
  matter_id: string | null;
  name: string;
  parent_id: string | null;
  created_at: string;
};

export type FolderNode = FolderRow & {
  children: FolderNode[];
  document_count?: number;
};

/**
 * Build a tree from flat folder rows (parent_id hierarchy).
 */
function buildFolderTree(rows: FolderRow[], parentId: string | null): FolderNode[] {
  return rows
    .filter((r) => (r.parent_id ?? null) === parentId)
    .map((row) => ({
      ...row,
      children: buildFolderTree(rows, row.id),
      document_count: 0,
    }));
}

/**
 * GET /api/folders
 * List folder tree. Query: matter_id (optional). Returns nested tree with document_count.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const matterId = req.query.matter_id as string | undefined;
    let query = supabase.from("folders").select("*").order("name", { ascending: true });
    if (matterId) query = query.eq("matter_id", matterId);
    const { data: rows, error: dbError } = await query;
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    const flat = (rows ?? []) as FolderRow[];
    const tree = buildFolderTree(flat, null);

    // Get document counts per folder (including subfolders: count docs in folder and all descendants)
    const folderIds = flat.map((f) => f.id);
    if (folderIds.length === 0) {
      return success(res, { folders: tree });
    }
    const { data: counts } = await supabase
      .from("document_folders")
      .select("folder_id")
      .in("folder_id", folderIds);
    const countByFolder = new Map<string, number>();
    for (const f of folderIds) countByFolder.set(f, 0);
    for (const row of counts ?? []) {
      const r = row as { folder_id: string };
      countByFolder.set(r.folder_id, (countByFolder.get(r.folder_id) ?? 0) + 1);
    }
    function setCounts(nodes: FolderNode[]): void {
      for (const n of nodes) {
        n.document_count = countByFolder.get(n.id) ?? 0;
        setCounts(n.children);
      }
    }
    setCounts(tree);

    return success(res, { folders: tree });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/folders
 * Create folder. Body: { name, parent_id?, matter_id? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as { name?: string; parent_id?: string | null; matter_id?: string | null };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return error(res, "name is required", 400, "VALIDATION");
    }
    const insert: Record<string, unknown> = { name };
    if (body.parent_id != null) insert.parent_id = body.parent_id || null;
    if (body.matter_id != null) insert.matter_id = body.matter_id || null;

    const { data: folder, error: dbError } = await supabase
      .from("folders")
      .insert(insert)
      .select()
      .single();

    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, folder, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/folders/:id
 * Get one folder by id.
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: folder, error: dbError } = await supabase
      .from("folders")
      .select("*")
      .eq("id", id)
      .single();
    if (dbError || !folder) {
      return error(res, dbError?.message ?? "Folder not found", 404, "NOT_FOUND");
    }
    return success(res, folder);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * PATCH /api/folders/:id
 * Update folder (rename). Body: { name }
 */
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body as { name?: string };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return error(res, "name is required", 400, "VALIDATION");
    }
    const { data: folder, error: dbError } = await supabase
      .from("folders")
      .update({ name })
      .eq("id", id)
      .select()
      .single();
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    if (!folder) {
      return error(res, "Folder not found", 404, "NOT_FOUND");
    }
    return success(res, folder);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * DELETE /api/folders/:id
 * Delete folder (and remove document assignments; subfolders CASCADE).
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { error: dbError } = await supabase.from("folders").delete().eq("id", id);
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, { deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/folders/:id/documents
 * Add documents to folder. Body: { documentIds: string[] }
 */
router.post("/:id/documents", async (req: Request, res: Response) => {
  try {
    const { id: folderId } = req.params;
    const body = req.body as { documentIds?: string[] };
    const documentIds = Array.isArray(body.documentIds) ? body.documentIds : [];
    if (documentIds.length === 0) {
      return success(res, { added: 0, folder_id: folderId });
    }

    const { data: folder, error: folderErr } = await supabase
      .from("folders")
      .select("id")
      .eq("id", folderId)
      .single();
    if (folderErr || !folder) {
      return error(res, "Folder not found", 404, "NOT_FOUND");
    }

    const rows = documentIds.map((docId) => ({ folder_id: folderId, document_id: docId }));
    const { error: insertErr } = await supabase.from("document_folders").upsert(rows, {
      onConflict: "document_id,folder_id",
      ignoreDuplicates: true,
    });
    if (insertErr) {
      return error(res, insertErr.message, 500, (insertErr as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, { added: documentIds.length, folder_id: folderId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * DELETE /api/folders/:id/documents/:documentId
 * Remove document from folder.
 */
router.delete("/:id/documents/:documentId", async (req: Request, res: Response) => {
  try {
    const { id: folderId, documentId } = req.params;
    const { error: dbError } = await supabase
      .from("document_folders")
      .delete()
      .eq("folder_id", folderId)
      .eq("document_id", documentId);
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, { removed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
