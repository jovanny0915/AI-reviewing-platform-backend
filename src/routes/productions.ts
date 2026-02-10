/**
 * Phase 7: Productions API — create production, start job, list, get, audit report, download.
 * Phase 8: Inbound productions — list import jobs, POST import (multipart DAT/OPT + tiff path).
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { createSupabaseClient } from "../lib/supabase.js";
import { success, error } from "../lib/api-response.js";
import { enqueueProduction } from "../lib/queue.js";
import { createSignedUrl } from "../lib/storage.js";
import { runInboundImport } from "../lib/inbound-import-job.js";

const router = Router();
const supabase = createSupabaseClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB for load files
});

export type ProductionRow = {
  id: string;
  matter_id: string | null;
  name: string;
  bates_prefix: string;
  bates_start_number: number;
  source_folder_id: string | null;
  include_subfolders: boolean;
  status: string;
  output_storage_path: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

/**
 * GET /api/productions
 * List productions. Query: matter_id, status. Includes document_count and page_count per production.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const matterId = req.query.matter_id as string | undefined;
    const status = req.query.status as string | undefined;
    let query = supabase
      .from("productions")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });
    if (matterId) query = query.eq("matter_id", matterId);
    if (status) query = query.eq("status", status);
    const { data: rows, error: dbError, count } = await query;
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    const productions = (rows ?? []) as (ProductionRow & { document_count?: number; page_count?: number })[];
    if (productions.length > 0) {
      const ids = productions.map((p) => p.id);
      const [docCounts, pageCounts] = await Promise.all([
        supabase.from("production_documents").select("production_id").in("production_id", ids),
        supabase.from("production_pages").select("production_id").in("production_id", ids),
      ]);
      const docByProd = new Map<string, number>();
      const pageByProd = new Map<string, number>();
      for (const r of docCounts.data ?? []) {
        const pid = (r as { production_id: string }).production_id;
        docByProd.set(pid, (docByProd.get(pid) ?? 0) + 1);
      }
      for (const r of pageCounts.data ?? []) {
        const pid = (r as { production_id: string }).production_id;
        pageByProd.set(pid, (pageByProd.get(pid) ?? 0) + 1);
      }
      for (const p of productions) {
        p.document_count = docByProd.get(p.id) ?? 0;
        p.page_count = pageByProd.get(p.id) ?? 0;
      }
    }
    return success(res, {
      productions,
      total: count ?? productions.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/productions
 * Create production (pending). Body: name, bates_prefix, bates_start_number, source_folder_id?, matter_id?, include_subfolders?.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      name?: string;
      bates_prefix?: string;
      bates_start_number?: number;
      source_folder_id?: string | null;
      matter_id?: string | null;
      include_subfolders?: boolean;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const bates_prefix = typeof body.bates_prefix === "string" ? body.bates_prefix.trim() : "PROD";
    const bates_start_number = Math.max(1, parseInt(String(body.bates_start_number), 10) || 1);
    if (!name) {
      return error(res, "name is required", 400, "VALIDATION");
    }
    const insert: Record<string, unknown> = {
      name,
      bates_prefix: bates_prefix || "PROD",
      bates_start_number,
      status: "pending",
      include_subfolders: body.include_subfolders !== false,
    };
    if (body.source_folder_id != null) insert.source_folder_id = body.source_folder_id || null;
    if (body.matter_id != null) insert.matter_id = body.matter_id || null;

    const { data: production, error: dbError } = await supabase
      .from("productions")
      .insert(insert)
      .select()
      .single();

    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, production as ProductionRow, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

// --- Phase 8: Inbound productions (must be before /:id) ---

export type InboundProductionRow = {
  id: string;
  matter_id: string | null;
  name: string;
  producing_party: string | null;
  status: string;
  dat_storage_path: string | null;
  opt_storage_path: string | null;
  tiff_base_path: string | null;
  error_message: string | null;
  document_count: number;
  created_at: string;
  completed_at: string | null;
};

/**
 * GET /api/productions/import
 * List inbound production imports.
 */
router.get("/import", async (req: Request, res: Response) => {
  try {
    const matterId = req.query.matter_id as string | undefined;
    const status = req.query.status as string | undefined;
    let query = supabase
      .from("inbound_productions")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });
    if (matterId) query = query.eq("matter_id", matterId);
    if (status) query = query.eq("status", status);
    const { data: rows, error: dbError, count } = await query;
    if (dbError) {
      return error(res, dbError.message, 500, (dbError as { code?: string }).code ?? "DB_ERROR");
    }
    return success(res, {
      imports: (rows ?? []) as InboundProductionRow[],
      total: count ?? (rows?.length ?? 0),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/productions/import
 * Create inbound import job: multipart name, producing_party, matter_id?, tiff_base_path, dat (file), opt (file optional).
 * Runs import synchronously and returns when complete (or failed).
 */
router.post(
  "/import",
  upload.fields([
    { name: "dat", maxCount: 1 },
    { name: "opt", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const body = req.body as { name?: string; producing_party?: string; matter_id?: string; tiff_base_path?: string };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const producing_party = typeof body.producing_party === "string" ? body.producing_party.trim() : null;
      const matter_id = typeof body.matter_id === "string" && body.matter_id.trim() ? body.matter_id.trim() : null;
      const tiff_base_path = typeof body.tiff_base_path === "string" ? body.tiff_base_path.trim() : "";
      const files = (req as Request & { files?: { dat?: Express.Multer.File[]; opt?: Express.Multer.File[] } }).files;
      const datFile = files?.dat?.[0];
      const optFile = files?.opt?.[0];

      if (!name) {
        return error(res, "name is required", 400, "VALIDATION");
      }
      if (!datFile || !datFile.buffer) {
        return error(res, "DAT file is required", 400, "VALIDATION");
      }
      if (!tiff_base_path) {
        return error(res, "tiff_base_path is required", 400, "VALIDATION");
      }

      const datContent = datFile.buffer.toString("utf-8");
      const optContent = optFile?.buffer ? optFile.buffer.toString("utf-8") : null;

      const { data: row, error: insertErr } = await supabase
        .from("inbound_productions")
        .insert({
          name,
          producing_party,
          matter_id,
          tiff_base_path,
          status: "processing",
          document_count: 0,
        })
        .select()
        .single();

      if (insertErr) {
        return error(res, insertErr.message, 500, "DB_ERROR");
      }
      const importId = (row as InboundProductionRow).id;

      const result = await runInboundImport({
        inboundProductionId: importId,
        datContent,
        optContent,
        tiffBasePath: tiff_base_path,
        matterId: matter_id,
      });

      if (result.error) {
        return success(res, {
          id: importId,
          status: "failed",
          document_count: result.documentCount,
          error_message: result.error,
        }, 201);
      }

      return success(res, {
        id: importId,
        status: "complete",
        document_count: result.documentCount,
        error_message: null,
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(res, message, 500, "INTERNAL_ERROR");
    }
  }
);

/**
 * GET /api/productions/import/:id
 * Get one inbound import job.
 */
router.get("/import/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: row, error: dbError } = await supabase
      .from("inbound_productions")
      .select("*")
      .eq("id", id)
      .single();
    if (dbError || !row) {
      return error(res, "Import not found", 404, "NOT_FOUND");
    }
    return success(res, row as InboundProductionRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/productions/:id
 * Get one production with document counts.
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: prod, error: dbError } = await supabase
      .from("productions")
      .select("*")
      .eq("id", id)
      .single();
    if (dbError || !prod) {
      return error(res, "Production not found", 404, "NOT_FOUND");
    }

    const { count: docCount } = await supabase
      .from("production_documents")
      .select("id", { count: "exact", head: true })
      .eq("production_id", id);

    const { count: pageCount } = await supabase
      .from("production_pages")
      .select("id", { count: "exact", head: true })
      .eq("production_id", id);

    return success(res, {
      ...(prod as ProductionRow),
      document_count: docCount ?? 0,
      page_count: pageCount ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/productions/:id/start
 * Start the production job (enqueue). Returns 202.
 */
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: prod, error: dbError } = await supabase
      .from("productions")
      .select("id, status")
      .eq("id", id)
      .single();
    if (dbError || !prod) {
      return error(res, "Production not found", 404, "NOT_FOUND");
    }
    if ((prod as { status: string }).status !== "pending") {
      return error(res, "Production can only be started when status is pending", 400, "VALIDATION");
    }
    enqueueProduction({ productionId: id });
    return res.status(202).json({
      success: true,
      message: "Production job started",
      production_id: id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/productions/:id/audit-report
 * Export production audit report (documents with hashes for validation).
 */
router.get("/:id/audit-report", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { getProductionAuditReport } = await import("../lib/production-job.js");
    const report = await getProductionAuditReport(id);
    return success(res, report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("not found")) return error(res, message, 404, "NOT_FOUND");
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/productions/:id/download
 * Return signed URL for production output folder (or ZIP in future). For now returns load file URLs.
 */
router.get("/:id/download", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: prod, error: dbError } = await supabase
      .from("productions")
      .select("output_storage_path, status")
      .eq("id", id)
      .single();
    if (dbError || !prod) {
      return error(res, "Production not found", 404, "NOT_FOUND");
    }
    const row = prod as { output_storage_path: string | null; status: string };
    if (row.status !== "complete" || !row.output_storage_path) {
      return error(res, "Production not complete or no output", 400, "VALIDATION");
    }
    const prefix = row.output_storage_path;
    const datPath = `${prefix}/loadfile.dat`;
    const optPath = `${prefix}/loadfile.opt`;
    const [datUrl, optUrl] = await Promise.all([
      createSignedUrl(datPath, 3600),
      createSignedUrl(optPath, 3600),
    ]);
    return success(res, {
      output_prefix: prefix,
      loadfile_dat_url: datUrl.url,
      loadfile_opt_url: optUrl.url,
      expires_in_seconds: 3600,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
