import { NextResponse, type NextRequest } from 'next/server';

import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Every real status this feature has, plus the JS-side 'active' shorthand
// list() understands (saved OR draft_opened) — derived from the ONE status
// vocabulary (maintenance/constants.ts) rather than a hand-copied literal
// array, so a future status addition can't silently drift this query-param
// allow-list out of sync with the service it forwards to.
const STATUS_VALUES = [...(Object.keys(MAINTENANCE_STATUS_LABELS) as MaintenanceStatus[]), 'active'] as const;

/**
 * List the caller's own (default) or the whole org's (scope=all, gated by
 * the service on maintenance_requests:read_all/manage) maintenance
 * requests. NOT module-gated — mirrors MaintenanceRequestsService.list()'s
 * own posture (0314 Q3): request history stays visible after a module
 * disable, only writes are gated. This route never calls anything Zendesk-
 * shaped; StockPilot cannot observe ticket state (brief §20/21).
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
  const q = url.searchParams.get('q')?.trim() || undefined;
  const statusParam = url.searchParams.get('status');
  const status = (STATUS_VALUES as readonly string[]).includes(statusParam ?? '')
    ? (statusParam as MaintenanceStatus | 'active')
    : undefined;

  try {
    const requests = await new MaintenanceRequestsService(ctx).list({ scope, q, status });
    return NextResponse.json({ requests });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.list' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Create a maintenance request. Body is `MaintenanceRequestFormValues`
 * (packages/core/src/schemas/maintenance.ts) — this route does NOT re-parse
 * it; MaintenanceRequestsService.create() is the single place that schema is
 * enforced (`.strict()` at every depth, so a recipient-shaped key is a hard
 * rejection there), matching the mobile-parity precedent in items/route.ts's
 * own doc comment: the route parses JSON, delegates, and maps errors — it
 * does not duplicate validation.
 *
 * Route contract: a rate-limit rejection from the service (20/hour/user,
 * `maintenance:create:<userId>`) throws ServiceError('conflict') — there is
 * no `rate_limited` member on ServiceError — so it surfaces here as 409
 * conflict, never 429. Same contract as the attachments mint route
 * (`[id]/attachments/route.ts`); mobile (Tasks 18-20) must check for 409,
 * not 429, to detect a throttled create.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const res = await new MaintenanceRequestsService(ctx).create(body);
    return NextResponse.json(res, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
