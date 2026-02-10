import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { success, error } from "../lib/api-response.js";

const router = Router();
const supabase = createSupabaseClient();

/**
 * GET /api/saved-searches
 * List saved searches, optionally by matter_id.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const matterId = req.query.matter_id as string | undefined;
    const userId = (req as Request & { userId?: string }).userId as string | undefined;

    let query = supabase
      .from("saved_searches")
      .select("*")
      .order("created_at", { ascending: false });

    if (matterId) query = query.eq("matter_id", matterId);
    if (userId) query = query.or(`user_id.eq.${userId},user_id.is.null`);
    // If no userId, return all (optionally scoped by matter_id)

    const { data, error: dbError } = await query;

    if (dbError) {
      const code = (dbError as { code?: string }).code ?? "DB_ERROR";
      return error(res, dbError.message, 500, code);
    }

    return success(res, { savedSearches: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/saved-searches
 * Create a saved search: name + params (custodian, dateFrom, dateTo, keyword, docType, familyId, folderId, etc.).
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId?: string }).userId ?? null;
    const body = req.body as { name: string; matter_id?: string; params?: Record<string, unknown> };

    if (!body.name?.trim()) {
      return error(res, "name is required", 400, "VALIDATION_ERROR");
    }

    const { data, error: insertErr } = await supabase
      .from("saved_searches")
      .insert({
        name: body.name.trim(),
        matter_id: body.matter_id ?? null,
        user_id: userId,
        params: body.params ?? {},
      })
      .select()
      .single();

    if (insertErr) {
      const code = (insertErr as { code?: string }).code ?? "DB_ERROR";
      return error(res, insertErr.message, 500, code);
    }

    return success(res, data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/saved-searches/:id
 * Get one saved search by id (e.g. to run it = use returned params in GET /api/documents).
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data, error: dbError } = await supabase
      .from("saved_searches")
      .select("*")
      .eq("id", id)
      .single();

    if (dbError || !data) {
      return error(res, dbError?.message ?? "Saved search not found", 404, "NOT_FOUND");
    }

    return success(res, data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * DELETE /api/saved-searches/:id
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { error: deleteErr } = await supabase.from("saved_searches").delete().eq("id", id);

    if (deleteErr) {
      const code = (deleteErr as { code?: string }).code ?? "DB_ERROR";
      return error(res, deleteErr.message, 500, code);
    }

    return success(res, { deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
