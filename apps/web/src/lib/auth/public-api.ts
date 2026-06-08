import 'server-only';

import { NextResponse } from 'next/server';

import { hasScope, withApiKey, type ApiKeyContext, type ApiScope } from './api-key';

/**
 * Guard for a public-API route: authenticate the API key, then require a scope.
 * Returns the org-scoped context on success, or a ready-to-return error
 * response (401 missing/invalid, 403 module-off/missing-scope, 429 rate-limit).
 *
 * IMPORTANT: there is NO user session on the public API, so RLS does not protect
 * these handlers. Every query MUST explicitly filter
 * `.eq('organization_id', ctx.organizationId)` — that is the sole tenant
 * isolation boundary. `ctx` carries only the org id + granted scopes.
 */
export async function authorizePublicApi(
  req: Request,
  scope: ApiScope,
): Promise<{ ctx: ApiKeyContext } | { res: NextResponse }> {
  const result = await withApiKey(req);
  if (!result.ok) {
    const headers: Record<string, string> = {};
    if (result.status === 429 && result.retryAfter) {
      headers['retry-after'] = String(result.retryAfter);
    }
    return { res: NextResponse.json({ error: result.error }, { status: result.status, headers }) };
  }
  if (!hasScope(result.ctx, scope)) {
    return {
      res: NextResponse.json(
        { error: `This API key is missing the required '${scope}' scope.` },
        { status: 403 },
      ),
    };
  }
  return { ctx: result.ctx };
}

/** Clamped list pagination from `?limit=&offset=` (default 50, max 200). The
 *  offset is also ceiling-capped so a key can't drive expensive deep scans /
 *  enumerate via `?offset=999999999`. */
const MAX_OFFSET = 1_000_000;
export function parsePageParams(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit')) || 50), 1), 200);
  const offset = Math.min(
    Math.max(Math.floor(Number(url.searchParams.get('offset')) || 0), 0),
    MAX_OFFSET,
  );
  return { limit, offset };
}
