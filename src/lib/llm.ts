/**
 * Phase 9.3: LLM integration — explicit user-initiated only.
 * Summarize selected docs/folder, suggest issue tags, relevance ranking suggestions.
 * No automated privilege or relevance decisions.
 */

import OpenAI from "openai";
import { createSupabaseClient } from "./supabase.js";
import { getDocumentText } from "./embeddings.js";
import { downloadDocument } from "./storage.js";

const DEFAULT_MODEL = "gpt-4o-mini";

function getOpenAI(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) return null;
  return new OpenAI({ apiKey: key });
}

/**
 * Get text for multiple documents (for summarization). Respects matter_id/folder scope.
 */
async function getTextsForDocumentIds(documentIds: string[]): Promise<Map<string, string>> {
  const supabase = createSupabaseClient();
  const out = new Map<string, string>();

  const { data: docs } = await supabase
    .from("documents")
    .select("id, extracted_text, extracted_text_path")
    .in("id", documentIds);

  for (const doc of docs ?? []) {
    const d = doc as { id: string; extracted_text?: string | null; extracted_text_path?: string | null };
    if (d.extracted_text != null && String(d.extracted_text).trim()) {
      out.set(d.id, String(d.extracted_text).trim());
      continue;
    }
    if (d.extracted_text_path) {
      const { buffer, error } = await downloadDocument(d.extracted_text_path);
      if (!error && buffer.length) out.set(d.id, buffer.toString("utf-8").trim());
    }
  }
  return out;
}

/**
 * Build a combined text blob for summarization (with doc labels), truncated to avoid token limits.
 */
function buildSummaryInput(texts: Map<string, string>, maxTotalChars = 120_000): string {
  const parts: string[] = [];
  let total = 0;
  for (const [id, text] of texts) {
    const slice = text.slice(0, 15_000);
    parts.push(`[Document ${id}]\n${slice}`);
    total += slice.length + 50;
    if (total >= maxTotalChars) break;
  }
  return parts.join("\n\n");
}

/**
 * Summarize a set of documents (or folder/matter scope). Uses cache when scope_type/scope_id match.
 */
export async function summarizeScope(params: {
  scope_type: "document" | "folder" | "matter";
  scope_id: string;
  matter_id: string | null;
  documentIds: string[];
}): Promise<{ summary: string; cached: boolean; error?: string }> {
  const supabase = createSupabaseClient();
  const { scope_type, scope_id, matter_id, documentIds } = params;

  const { data: cached } = await supabase
    .from("document_summaries")
    .select("summary, document_count")
    .eq("scope_type", scope_type)
    .eq("scope_id", scope_id)
    .single();

  if (cached && (cached as { summary?: string }).summary) {
    return {
      summary: (cached as { summary: string }).summary,
      cached: true,
    };
  }

  const openai = getOpenAI();
  if (!openai) return { summary: "", cached: false, error: "OPENAI_API_KEY not set" };

  if (documentIds.length === 0) return { summary: "", cached: false, error: "No documents in scope" };

  const texts = await getTextsForDocumentIds(documentIds);
  if (texts.size === 0) return { summary: "", cached: false, error: "No extracted text in selected documents" };

  const input = buildSummaryInput(texts);
  const systemPrompt =
    "You are summarizing document sets for a litigation e-discovery review. Output a concise, factual summary. Do not make legal conclusions about relevance or privilege. Focus on: main topics, key entities, dates, and document types.";

  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_SUMMARIZE_MODEL || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Summarize the following document set (${texts.size} documents):\n\n${input}` },
      ],
      max_tokens: 2000,
    });
    const summary = res.choices?.[0]?.message?.content?.trim() ?? "";
    if (!summary) return { summary: "", cached: false, error: "Empty summary response" };

    await supabase.from("document_summaries").upsert(
      {
        scope_type,
        scope_id,
        matter_id,
        summary,
        model: process.env.OPENAI_SUMMARIZE_MODEL || DEFAULT_MODEL,
        document_count: documentIds.length,
      },
      { onConflict: "scope_type,scope_id" }
    );

    return { summary, cached: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: "", cached: false, error: msg };
  }
}

/**
 * Suggest issue tags for a set of documents. Human decides which to apply.
 */
export async function suggestIssueTags(params: {
  documentIds: string[];
}): Promise<{ suggestions: { documentId: string; suggestedTags: string[] }[]; error?: string }> {
  const openai = getOpenAI();
  if (!openai) return { suggestions: [], error: "OPENAI_API_KEY not set" };

  const texts = await getTextsForDocumentIds(params.documentIds);
  if (texts.size === 0) return { suggestions: [], error: "No extracted text" };

  const input = buildSummaryInput(texts, 60_000);
  const systemPrompt =
    "You suggest short issue/category tags for e-discovery documents (e.g. Budget, Contract, HR, Compliance). Output only a JSON array of objects: [{ \"documentId\": \"<id>\", \"tags\": [\"tag1\", \"tag2\"] }]. Use the document IDs from the [Document <id>] headers. Do not make privilege or relevance determinations.";

  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_SUGGESTIONS_MODEL || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Suggest issue tags for these documents:\n\n${input}` },
      ],
      max_tokens: 1500,
    });
    const raw = res.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseJsonSuggestions(raw, Array.from(texts.keys()));
    return { suggestions: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { suggestions: [], error: msg };
  }
}

function parseJsonSuggestions(
  raw: string,
  validIds: string[]
): { documentId: string; suggestedTags: string[] }[] {
  const idSet = new Set(validIds);
  try {
    const json = raw.replace(/```json?\s*|\s*```/g, "").trim();
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o: unknown) => o && typeof o === "object" && "documentId" in o && "tags" in o)
      .filter((o: { documentId: string }) => idSet.has(o.documentId))
      .map((o: { documentId: string; tags: unknown }) => ({
        documentId: o.documentId,
        suggestedTags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Suggest relevance ranking (order) for a set of documents. Human decides; AI only suggests.
 */
export async function suggestRelevanceRanking(params: {
  documentIds: string[];
  query?: string;
}): Promise<{ documentIds: string[]; explanation?: string; error?: string }> {
  const openai = getOpenAI();
  if (!openai) return { documentIds: [], error: "OPENAI_API_KEY not set" };

  const texts = await getTextsForDocumentIds(params.documentIds);
  if (texts.size === 0) return { documentIds: [], error: "No extracted text" };

  const input = buildSummaryInput(texts, 60_000);
  const queryHint = params.query
    ? `User is interested in: ${params.query}. Rank by likely relevance to this.`
    : "Rank by likely relevance for general litigation review (most relevant first).";
  const systemPrompt =
    "You suggest a relevance ranking for e-discovery documents. Output a JSON object: { \"documentIds\": [\"id1\", \"id2\", ...] } with document IDs in order from most to least relevant. Use only the document IDs from the [Document <id>] headers. Include an optional \"explanation\" string. Do not make privilege determinations.";

  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_SUGGESTIONS_MODEL || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${queryHint}\n\nDocuments:\n\n${input}` },
      ],
      max_tokens: 1500,
    });
    const raw = res.choices?.[0]?.message?.content?.trim() ?? "";
    const validIds = Array.from(texts.keys());
    const { documentIds: ordered, explanation } = parseRankingResponse(raw, validIds);
    return { documentIds: ordered, explanation };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { documentIds: [], error: msg };
  }
}

function parseRankingResponse(
  raw: string,
  validIds: string[]
): { documentIds: string[]; explanation?: string } {
  const idSet = new Set(validIds);
  try {
    const json = raw.replace(/```json?\s*|\s*```/g, "").trim();
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return { documentIds: [] };
    const arr = obj.documentIds;
    const ordered = Array.isArray(arr)
      ? arr.filter((id: unknown) => typeof id === "string" && idSet.has(id))
      : [];
    const explanation = typeof obj.explanation === "string" ? obj.explanation : undefined;
    return { documentIds: ordered, explanation };
  } catch {
    return { documentIds: [] };
  }
}
