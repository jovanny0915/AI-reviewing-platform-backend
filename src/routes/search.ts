/**
 * Phase 5: Search (Primary: Keyword + Metadata)
 * GET /api/search?q=...&scope=content|metadata|both&matter_id=...&page=1&pageSize=20
 * Returns document ids, snippets (KWIC), hit counts. No LLM calls.
 */

import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { success, error } from "../lib/api-response.js";

const router = Router();
const supabase = createSupabaseClient();

type SearchScope = "content" | "metadata" | "both";

router.get("/", async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string)?.trim() ?? "";
    const scope = ((req.query.scope as string) || "both").toLowerCase() as SearchScope;
    const matterId = (req.query.matter_id as string) || null;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string) || 20));

    if (!q) {
      return success(res, {
        results: [],
        total: 0,
        page: 1,
        pageSize,
      });
    }

    const validScopes: SearchScope[] = ["content", "metadata", "both"];
    const p_scope = validScopes.includes(scope) ? scope : "both";
    const p_offset = (page - 1) * pageSize;

    const { data: rows, error: rpcErr } = await supabase.rpc("search_documents", {
      p_query: q,
      p_scope,
      p_matter_id: matterId || null,
      p_limit: pageSize,
      p_offset: p_offset,
    });

    if (rpcErr) {
      const code = (rpcErr as { code?: string }).code ?? "DB_ERROR";
      return error(res, rpcErr.message, 500, code);
    }

    const results = (rows ?? []) as { id: string; snippet: string | null; hit_count: number; total_count: number }[];
    const total = results[0]?.total_count ?? 0;
    const ids = results.map((r) => r.id);

    if (ids.length === 0) {
      return success(res, {
        results: [],
        total: Number(total),
        page,
        pageSize,
      });
    }

    const { data: docs, error: docsErr } = await supabase
      .from("documents")
      .select("id, original_filename, filename, custodian, created_at, file_type, matter_id, family_id")
      .in("id", ids);

    if (docsErr) {
      const code = (docsErr as { code?: string }).code ?? "DB_ERROR";
      return error(res, docsErr.message, 500, code);
    }

    const docMap = new Map((docs ?? []).map((d: { id: string }) => [d.id, d]));
    const resultsWithDocs = results.map((r) => ({
      documentId: r.id,
      snippet: r.snippet ?? "",
      hitCount: r.hit_count,
      document: docMap.get(r.id) ?? null,
    }));

    return success(res, {
      results: resultsWithDocs,
      total: Number(total),
      page,
      pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
