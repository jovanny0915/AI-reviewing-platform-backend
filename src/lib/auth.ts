import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

/**
 * Optional auth middleware (Phase 0.5).
 * When SUPABASE_ANON_KEY is set and Authorization: Bearer <jwt> is present,
 * validates the JWT via Supabase Auth and sets req.userId for audit and matter isolation.
 * When auth is not configured or no token is sent, requests continue without userId.
 */
export function optionalAuthMiddleware(
  req: Request & { userId?: string },
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!token || !url || !anonKey) {
    next();
    return;
  }

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  supabase.auth
    .getUser(token)
    .then(({ data: { user }, error }) => {
      if (!error && user?.id) req.userId = user.id;
      next();
    })
    .catch(() => next());
}
