/**
 * Phase 9.1–9.2: Embeddings — one-time or on-demand per doc; stored in pgvector.
 * Optional semantic search / find-similar when user explicitly requests.
 */

import OpenAI from "openai";
import { createSupabaseClient } from "./supabase.js";
import { downloadDocument } from "./storage.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

function getOpenAI(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) return null;
  return new OpenAI({ apiKey: key });
}

/**
 * Get extracted text for a document: from DB column if present, else from storage.
 */
export async function getDocumentText(documentId: string): Promise<{ text: string; error?: string }> {
  const supabase = createSupabaseClient();
  const { data: doc, error: dbErr } = await supabase
    .from("documents")
    .select("extracted_text, extracted_text_path")
    .eq("id", documentId)
    .single();

  if (dbErr || !doc) return { text: "", error: "Document not found" };

  const fromDb = (doc as { extracted_text?: string | null }).extracted_text;
  if (fromDb != null && String(fromDb).trim().length > 0) {
    return { text: String(fromDb).trim() };
  }

  const path = (doc as { extracted_text_path?: string | null }).extracted_text_path;
  if (!path) return { text: "", error: "No extracted text" };

  const { buffer, error: downloadErr } = await downloadDocument(path);
  if (downloadErr || !buffer.length) return { text: "", error: downloadErr ?? "Failed to load text" };
  return { text: buffer.toString("utf-8").trim() };
}

/**
 * Truncate text to a safe length for embedding (e.g. ~8k tokens ≈ 32k chars).
 */
function truncateForEmbedding(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Generate embedding for text via OpenAI; returns array of length EMBEDDING_DIMENSIONS.
 */
export async function getEmbeddingForText(text: string): Promise<{ embedding: number[]; error?: string }> {
  const openai = getOpenAI();
  if (!openai) return { embedding: [], error: "OPENAI_API_KEY not set" };

  const truncated = truncateForEmbedding(text);
  if (!truncated) return { embedding: [], error: "No text to embed" };

  try {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
    });
    const vec = res.data?.[0]?.embedding;
    if (!vec || !Array.isArray(vec)) return { embedding: [], error: "Empty embedding response" };
    return { embedding: vec };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { embedding: [], error: msg };
  }
}

/**
 * Get or create embedding for a document; store in document_embeddings (cached).
 */
export async function getOrCreateDocumentEmbedding(documentId: string): Promise<{
  embedding: number[] | null;
  error?: string;
}> {
  const supabase = createSupabaseClient();

  const { data: existing } = await supabase
    .from("document_embeddings")
    .select("embedding")
    .eq("document_id", documentId)
    .single();

  if (existing && (existing as { embedding?: number[] }).embedding) {
    return { embedding: (existing as { embedding: number[] }).embedding };
  }

  const { text, error: textErr } = await getDocumentText(documentId);
  if (textErr || !text) return { embedding: null, error: textErr ?? "No text" };

  const { embedding, error: embedErr } = await getEmbeddingForText(text);
  if (embedErr || !embedding.length) return { embedding: null, error: embedErr };

  const { error: upsertErr } = await supabase.from("document_embeddings").upsert(
    {
      document_id: documentId,
      embedding,
      model: EMBEDDING_MODEL,
    },
    { onConflict: "document_id" }
  );

  if (upsertErr) return { embedding: null, error: upsertErr.message };
  return { embedding };
}

/**
 * Find documents similar to the given document (vector similarity). User-initiated only.
 */
export async function findSimilarDocuments(params: {
  documentId: string;
  limit?: number;
  matter_id?: string | null;
}): Promise<{ documentIds: string[]; error?: string }> {
  const { documentId, limit = 20, matter_id } = params;
  const supabase = createSupabaseClient();

  const { embedding, error: embedErr } = await getOrCreateDocumentEmbedding(documentId);
  if (embedErr || !embedding?.length) return { documentIds: [], error: embedErr ?? "No embedding" };

  const { data: rows, error: rpcErr } = await supabase.rpc("match_document_embeddings", {
    p_query_embedding: embedding,
    p_exclude_document_id: documentId,
    p_matter_id: matter_id ?? null,
    p_limit: Math.min(50, Math.max(1, limit)),
  });

  if (rpcErr) return { documentIds: [], error: rpcErr.message };
  const list = (rows ?? []) as { document_id: string }[];
  return { documentIds: list.map((r) => r.document_id) };
}
