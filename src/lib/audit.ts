import { createSupabaseClient } from "./supabase.js";

export type AuditActionType = "view" | "upload" | "tag" | "redact" | "produce";

export type AuditEntry = {
  user_id?: string | null;
  document_id?: string | null;
  action_type: AuditActionType;
  metadata_snapshot?: Record<string, unknown>;
};

/**
 * Append an event to the append-only audit_log.
 * Every mutation (upload, tag, redact, produce) should call this.
 */
export async function appendAuditLog(entry: AuditEntry): Promise<{ error?: string }> {
  const supabase = createSupabaseClient();
  const { error } = await supabase.from("audit_log").insert({
    user_id: entry.user_id ?? null,
    document_id: entry.document_id ?? null,
    action_type: entry.action_type,
    metadata_snapshot: entry.metadata_snapshot ?? {},
  });
  if (error) return { error: error.message };
  return {};
}
