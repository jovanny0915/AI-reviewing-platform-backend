/**
 * Phase 9.4: AI usage tracking and caps per matter/user.
 * Target: ~$5–$15 per 1,000 documents; caps enforced per matter (and optionally per user).
 */

import { createSupabaseClient } from "./supabase.js";

export type AiActionType = "embedding" | "summarize" | "similar" | "suggestions";

const DEFAULT_CAP_PER_MATTER_PER_MONTH = 10_000; // units (e.g. doc count)
const CAP_ENV = "AI_USAGE_CAP_PER_MATTER_PER_MONTH";

function getCap(): number {
  const v = process.env[CAP_ENV];
  if (v == null || v === "") return DEFAULT_CAP_PER_MATTER_PER_MONTH;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_PER_MATTER_PER_MONTH;
}

/**
 * Record AI usage for a matter/user. Used for cost controls.
 */
export async function recordAiUsage(params: {
  matter_id: string | null;
  user_id: string | null;
  action_type: AiActionType;
  units?: number;
}): Promise<{ error?: string }> {
  const supabase = createSupabaseClient();
  const { error } = await supabase.from("ai_usage").insert({
    matter_id: params.matter_id ?? null,
    user_id: params.user_id ?? null,
    action_type: params.action_type,
    units: params.units ?? 1,
  });
  if (error) return { error: error.message };
  return {};
}

/**
 * Get usage for the current month for a matter (and optionally user).
 * Returns { used, cap } so caller can enforce cap.
 */
export async function getAiUsageCurrentMonth(params: {
  matter_id: string | null;
  user_id?: string | null;
}): Promise<{ used: number; cap: number; error?: string }> {
  const supabase = createSupabaseClient();
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const startIso = startOfMonth.toISOString();

  let query = supabase
    .from("ai_usage")
    .select("units")
    .gte("created_at", startIso);

  if (params.matter_id) query = query.eq("matter_id", params.matter_id);
  if (params.user_id != null && params.user_id !== "") query = query.eq("user_id", params.user_id);

  const { data, error } = await query;
  if (error) return { used: 0, cap: getCap(), error: error.message };

  const used = (data ?? []).reduce((sum: number, row: { units?: number }) => sum + (row.units ?? 1), 0);
  return { used, cap: getCap() };
}

/**
 * Check if adding `units` would exceed the matter (or user) cap for the current month.
 */
export async function wouldExceedCap(params: {
  matter_id: string | null;
  user_id?: string | null;
  additionalUnits: number;
}): Promise<{ allowed: boolean; used: number; cap: number }> {
  const { used, cap } = await getAiUsageCurrentMonth({
    matter_id: params.matter_id,
    user_id: params.user_id,
  });
  return {
    allowed: used + params.additionalUnits <= cap,
    used,
    cap,
  };
}
