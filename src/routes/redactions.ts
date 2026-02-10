import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { appendAuditLog } from "../lib/audit.js";
import { success, error } from "../lib/api-response.js";

const router = Router();
const supabase = createSupabaseClient();

export type RedactionRow = {
  id: string;
  document_id: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason_code: string;
  polygon: unknown;
  created_at: string;
};

function getUserId(req: Request): string | null {
  return (req as Request & { userId?: string }).userId ?? null;
}

/**
 * GET /api/redactions?documentId=...
 * List all redactions for a document. Required query: documentId.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const documentId = req.query.documentId as string;
    if (!documentId) {
      return error(res, "documentId is required", 400, "MISSING_PARAM");
    }
    const { data: rows, error: dbError } = await supabase
      .from("redactions")
      .select("*")
      .eq("document_id", documentId)
      .order("page_number", { ascending: true })
      .order("created_at", { ascending: true });
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, { redactions: (rows ?? []) as RedactionRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/redactions
 * Create a redaction. Body: document_id, page_number, x, y, width, height, reason_code, polygon?.
 * Writes to audit_log (action_type: redact).
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { document_id, page_number, x, y, width, height, reason_code, polygon } = req.body ?? {};
    if (
      typeof document_id !== "string" ||
      typeof page_number !== "number" ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      typeof reason_code !== "string" ||
      reason_code.trim() === ""
    ) {
      return error(
        res,
        "document_id (string), page_number (number), x, y, width, height (numbers), reason_code (non-empty string) are required",
        400,
        "VALIDATION_ERROR"
      );
    }
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("id")
      .eq("id", document_id)
      .single();
    if (docErr || !doc) {
      return error(res, "Document not found", 404, "NOT_FOUND");
    }
    const insert: Record<string, unknown> = {
      document_id,
      page_number,
      x,
      y,
      width,
      height,
      reason_code: reason_code.trim(),
    };
    if (polygon != null) insert.polygon = polygon;

    const { data: row, error: insertErr } = await supabase
      .from("redactions")
      .insert(insert)
      .select()
      .single();
    if (insertErr) {
      return error(res, insertErr.message, 500, (insertErr as { code?: string }).code ?? "DB_ERROR");
    }

    await appendAuditLog({
      user_id: userId,
      document_id,
      action_type: "redact",
      metadata_snapshot: {
        redaction_id: (row as RedactionRow).id,
        action: "create",
        page_number,
        reason_code: (row as RedactionRow).reason_code,
      },
    });

    return success(res, row as RedactionRow, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * PATCH /api/redactions/:id
 * Update a redaction. Body: page_number?, x?, y?, width?, height?, reason_code?, polygon?.
 * Writes to audit_log (action_type: redact).
 */
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const body = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (typeof body.page_number === "number") updates.page_number = body.page_number;
    if (typeof body.x === "number") updates.x = body.x;
    if (typeof body.y === "number") updates.y = body.y;
    if (typeof body.width === "number") updates.width = body.width;
    if (typeof body.height === "number") updates.height = body.height;
    if (typeof body.reason_code === "string" && body.reason_code.trim() !== "")
      updates.reason_code = body.reason_code.trim();
    if (body.polygon !== undefined) updates.polygon = body.polygon;

    if (Object.keys(updates).length === 0) {
      return error(res, "No valid fields to update", 400, "VALIDATION_ERROR");
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("redactions")
      .select("id, document_id, page_number, reason_code")
      .eq("id", id)
      .single();
    if (fetchErr || !existing) {
      return error(res, "Redaction not found", 404, "NOT_FOUND");
    }

    const { data: row, error: updateErr } = await supabase
      .from("redactions")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (updateErr) {
      return error(res, updateErr.message, 500, (updateErr as { code?: string }).code ?? "DB_ERROR");
    }

    await appendAuditLog({
      user_id: userId,
      document_id: (existing as { document_id: string }).document_id,
      action_type: "redact",
      metadata_snapshot: {
        redaction_id: id,
        action: "update",
        page_number: (row as RedactionRow).page_number,
        reason_code: (row as RedactionRow).reason_code,
      },
    });

    return success(res, row as RedactionRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * DELETE /api/redactions/:id
 * Delete a redaction. Writes to audit_log (action_type: redact).
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabase
      .from("redactions")
      .select("id, document_id, page_number, reason_code")
      .eq("id", id)
      .single();
    if (fetchErr || !existing) {
      return error(res, "Redaction not found", 404, "NOT_FOUND");
    }

    const { error: deleteErr } = await supabase.from("redactions").delete().eq("id", id);
    if (deleteErr) {
      return error(res, deleteErr.message, 500, (deleteErr as { code?: string }).code ?? "DB_ERROR");
    }

    await appendAuditLog({
      user_id: userId,
      document_id: (existing as { document_id: string }).document_id,
      action_type: "redact",
      metadata_snapshot: {
        redaction_id: id,
        action: "delete",
        page_number: (existing as RedactionRow).page_number,
        reason_code: (existing as RedactionRow).reason_code,
      },
    });

    return success(res, { deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
