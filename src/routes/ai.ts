/**
 * Phase 9: AI-Assisted Review API.
 * POST /api/ai/summarize, /api/ai/similar, /api/ai/suggestions, /api/ai/embed
 * GET /api/ai/usage
 * All AI actions are explicit user-initiated; no automated privilege/relevance decisions.
 */

import { Router, Request, Response } from "express";
import { createSupabaseClient } from "../lib/supabase.js";
import { success, error } from "../lib/api-response.js";
import { getOrCreateDocumentEmbedding, findSimilarDocuments, getDocumentText } from "../lib/embeddings.js";
import { summarizeScope, suggestIssueTags, suggestRelevanceRanking } from "../lib/llm.js";
import { recordAiUsage, getAiUsageCurrentMonth, wouldExceedCap } from "../lib/ai-usage.js";

const router = Router();
const supabase = createSupabaseClient();

async function getDocumentIdsForFolder(
  folderId: string,
  includeSubfolders: boolean
): Promise<string[]> {
  if (!includeSubfolders) {
    const { data } = await supabase
      .from("document_folders")
      .select("document_id")
      .eq("folder_id", folderId);
    return [...new Set((data ?? []).map((r: { document_id: string }) => r.document_id))];
  }
  const { data: allFolders } = await supabase.from("folders").select("id, parent_id");
  const rows = (allFolders ?? []) as { id: string; parent_id: string | null }[];
  const byParent = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.parent_id ?? "";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(r.id);
  }
  const folderIds: string[] = [];
  const stack: string[] = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    folderIds.push(id);
    for (const childId of byParent.get(id) ?? []) stack.push(childId);
  }
  if (folderIds.length === 0) return [];
  const { data } = await supabase
    .from("document_folders")
    .select("document_id")
    .in("folder_id", folderIds);
  return [...new Set((data ?? []).map((r: { document_id: string }) => r.document_id))];
}

function getUserId(req: Request): string | null {
  return (req as Request & { userId?: string }).userId ?? null;
}

/**
 * POST /api/ai/summarize
 * Body: { documentIds?: string[], folderId?: string, matter_id?: string, includeSubfolders?: boolean }
 * Scope: document set, or folder (with optional subfolders). Cached by scope.
 */
router.post("/summarize", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      documentIds?: string[];
      folderId?: string;
      matter_id?: string | null;
      includeSubfolders?: boolean;
    };
    const matter_id = body.matter_id ?? null;
    const userId = getUserId(req);

    let documentIds: string[] = [];
    let scope_type: "document" | "folder" | "matter" = "document";
    let scope_id: string;

    if (body.folderId) {
      scope_type = "folder";
      scope_id = body.folderId;
      documentIds = await getDocumentIdsForFolder(
        body.folderId,
        body.includeSubfolders === true
      );
    } else if (body.documentIds?.length) {
      scope_id = body.documentIds.sort().join(",");
      documentIds = body.documentIds;
    } else if (body.matter_id) {
      scope_type = "matter";
      scope_id = body.matter_id;
      const { data: docs } = await supabase
        .from("documents")
        .select("id")
        .eq("matter_id", body.matter_id);
      documentIds = (docs ?? []).map((d: { id: string }) => d.id);
    } else {
      return error(res, "Provide documentIds, folderId, or matter_id", 400, "VALIDATION");
    }

    if (documentIds.length === 0) {
      return success(res, { summary: "", cached: false, documentCount: 0 });
    }

    const { allowed, used, cap } = await wouldExceedCap({
      matter_id,
      user_id: userId,
      additionalUnits: documentIds.length,
    });
    if (!allowed) {
      return error(
        res,
        `AI usage cap exceeded (used ${used}, cap ${cap}). Contact admin to increase cap.`,
        429,
        "USAGE_CAP_EXCEEDED"
      );
    }

    const result = await summarizeScope({
      scope_type,
      scope_id,
      matter_id,
      documentIds,
    });

    if (result.error) {
      return error(res, result.error, 500, "AI_ERROR");
    }

    await recordAiUsage({
      matter_id,
      user_id: userId,
      action_type: "summarize",
      units: documentIds.length,
    });

    return success(res, {
      summary: result.summary,
      cached: result.cached,
      documentCount: documentIds.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/ai/similar
 * Body: { documentId: string, limit?: number, matter_id?: string }
 * Returns similar document IDs (vector similarity). User-initiated only.
 */
router.post("/similar", async (req: Request, res: Response) => {
  try {
    const body = req.body as { documentId?: string; limit?: number; matter_id?: string | null };
    const documentId = body.documentId;
    if (!documentId) {
      return error(res, "documentId is required", 400, "VALIDATION");
    }

    const matter_id = body.matter_id ?? null;
    const userId = getUserId(req);

    const { allowed, used, cap } = await wouldExceedCap({
      matter_id,
      user_id: userId,
      additionalUnits: 1,
    });
    if (!allowed) {
      return error(
        res,
        `AI usage cap exceeded (used ${used}, cap ${cap}).`,
        429,
        "USAGE_CAP_EXCEEDED"
      );
    }

    const result = await findSimilarDocuments({
      documentId,
      limit: body.limit ?? 20,
      matter_id,
    });

    if (result.error) {
      return error(res, result.error, 500, "AI_ERROR");
    }

    await recordAiUsage({
      matter_id,
      user_id: userId,
      action_type: "similar",
      units: 1,
    });

    return success(res, {
      documentId,
      similarDocumentIds: result.documentIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/ai/suggestions
 * Body: { documentIds: string[], type?: 'issue_tags' | 'relevance_ranking', query?: string }
 * Returns suggested issue tags or relevance ranking. Human decides; AI only suggests.
 */
router.post("/suggestions", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      documentIds?: string[];
      type?: "issue_tags" | "relevance_ranking";
      query?: string;
    };
    const documentIds = body.documentIds ?? [];
    if (documentIds.length === 0) {
      return error(res, "documentIds is required and must not be empty", 400, "VALIDATION");
    }

    const matter_id = (req.body as { matter_id?: string | null }).matter_id ?? null;
    const userId = getUserId(req);

    const { allowed, used, cap } = await wouldExceedCap({
      matter_id,
      user_id: userId,
      additionalUnits: documentIds.length,
    });
    if (!allowed) {
      return error(
        res,
        `AI usage cap exceeded (used ${used}, cap ${cap}).`,
        429,
        "USAGE_CAP_EXCEEDED"
      );
    }

    const type = body.type ?? "issue_tags";

    if (type === "issue_tags") {
      const result = await suggestIssueTags({ documentIds });
      if (result.error) return error(res, result.error, 500, "AI_ERROR");
      await recordAiUsage({
        matter_id,
        user_id: userId,
        action_type: "suggestions",
        units: documentIds.length,
      });
      return success(res, { type: "issue_tags", suggestions: result.suggestions });
    }

    const result = await suggestRelevanceRanking({
      documentIds,
      query: body.query,
    });
    if (result.error) return error(res, result.error, 500, "AI_ERROR");
    await recordAiUsage({
      matter_id,
      user_id: userId,
      action_type: "suggestions",
      units: documentIds.length,
    });
    return success(res, {
      type: "relevance_ranking",
      documentIds: result.documentIds,
      explanation: result.explanation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * POST /api/ai/embed
 * Body: { documentIds?: string[], folderId?: string, includeSubfolders?: boolean }
 * Trigger embedding generation for documents (on-demand). Cached per document.
 */
router.post("/embed", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      documentIds?: string[];
      folderId?: string;
      includeSubfolders?: boolean;
    };

    let documentIds: string[] = body.documentIds ?? [];
    if (body.folderId) {
      documentIds = await getDocumentIdsForFolder(
        body.folderId,
        body.includeSubfolders === true
      );
    }
    if (documentIds.length === 0) {
      return error(res, "Provide documentIds or folderId", 400, "VALIDATION");
    }

    const matter_id = (req.body as { matter_id?: string | null }).matter_id ?? null;
    const userId = getUserId(req);

    const { allowed, used, cap } = await wouldExceedCap({
      matter_id,
      user_id: userId,
      additionalUnits: documentIds.length,
    });
    if (!allowed) {
      return error(
        res,
        `AI usage cap exceeded (used ${used}, cap ${cap}).`,
        429,
        "USAGE_CAP_EXCEEDED"
      );
    }

    const results: { documentId: string; ok: boolean; error?: string }[] = [];
    for (const docId of documentIds) {
      const { embedding, error: embedErr } = await getOrCreateDocumentEmbedding(docId);
      results.push({
        documentId: docId,
        ok: !!embedding?.length,
        error: embedErr,
      });
    }

    const okCount = results.filter((r) => r.ok).length;
    await recordAiUsage({
      matter_id,
      user_id: userId,
      action_type: "embedding",
      units: okCount,
    });

    return success(res, {
      requested: documentIds.length,
      embedded: okCount,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

/**
 * GET /api/ai/usage
 * Query: matter_id?, user_id?
 * Returns current month usage and cap.
 */
router.get("/usage", async (req: Request, res: Response) => {
  try {
    const matter_id = (req.query.matter_id as string) || null;
    const user_id = (req.query.user_id as string) || null;

    const { used, cap, error: err } = await getAiUsageCurrentMonth({
      matter_id,
      user_id,
    });
    if (err) return error(res, err, 500, "DB_ERROR");
    return success(res, { used, cap, period: "current_month" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return error(res, message, 500, "INTERNAL_ERROR");
  }
});

export default router;
