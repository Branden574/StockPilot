import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Public-API key auth. External systems send `Authorization: Bearer sk_live_…`.
 *
 * Keys are high-entropy (192-bit) and we persist ONLY their SHA-256 hash, so a
 * DB leak can't yield a usable key (and timing-safe compare is unnecessary at
 * this entropy). The resolver also enforces the `api_access` module being on for
 * the org and a per-key rate limit, and is fully decoupled from the cookie/JWT
 * session auth used by the dashboard + mobile app.
 */

export const API_SCOPES = [
  'inventory:read',
  'inventory:write',
  'orders:read',
  'purchase_orders:read',
  // Subscribe/unsubscribe automation webhooks (Zapier/Make/n8n REST hooks).
  // Creates org-scoped integration_endpoints; delivery stays SSRF-guarded + HMAC-signed.
  'webhooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyContext {
  organizationId: string;
  keyId: string;
  scopes: string[];
}

const KEY_RE = /^Bearer\s+(sk_live_[a-f0-9]{16,})$/i;
/** A single key may make this many requests per minute (closed-mode limiter). */
const PER_KEY_PER_MINUTE = 600;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Mint a new key. The raw `key` is returned to the caller ONCE; we store hash. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `sk_live_${randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 16), hash: hashApiKey(key) };
}

export type ApiKeyResult =
  | { ok: true; ctx: ApiKeyContext }
  | { ok: false; status: 401 | 403 | 429; error: string; retryAfter?: number };

/**
 * Resolve + authorize a public-API request from its Bearer key. Returns an
 * org-scoped context (no user) or a typed failure the route maps to a status.
 */
export async function withApiKey(req: Request): Promise<ApiKeyResult> {
  const m = (req.headers.get('authorization') ?? '').match(KEY_RE);
  if (!m || !m[1]) {
    return { ok: false, status: 401, error: 'Missing or malformed API key.' };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('api_keys')
    .select('id, organization_id, scopes, revoked_at, expires_at')
    .eq('key_hash', hashApiKey(m[1]))
    .maybeSingle();
  if (error || !data) return { ok: false, status: 401, error: 'Invalid API key.' };

  const row = data as {
    id: string;
    organization_id: string;
    scopes: string[] | null;
    revoked_at: string | null;
    expires_at: string | null;
  };
  if (row.revoked_at) return { ok: false, status: 401, error: 'API key revoked.' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, error: 'API key expired.' };
  }

  // Org must have the api_access module enabled (it's a premium module).
  const { data: mod } = await admin
    .from('organization_modules')
    .select('enabled')
    .eq('organization_id', row.organization_id)
    .eq('module_id', 'api_access')
    .maybeSingle();
  if (!(mod as { enabled?: boolean } | null)?.enabled) {
    return { ok: false, status: 403, error: 'API access is not enabled for this organization.' };
  }

  // Per-key throttle (closed: a limiter outage denies rather than opening the
  // public API wide).
  const rl = await checkRateLimit(`api-key:${row.id}`, PER_KEY_PER_MINUTE, 60_000, 'closed');
  if (!rl.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Rate limit exceeded.',
      retryAfter: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
    };
  }

  // Best-effort last-used stamp (fire-and-forget).
  void admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);

  return { ok: true, ctx: { organizationId: row.organization_id, keyId: row.id, scopes: row.scopes ?? [] } };
}

/** True when the key carries the required scope. */
export function hasScope(ctx: ApiKeyContext, scope: ApiScope): boolean {
  return ctx.scopes.includes(scope);
}
