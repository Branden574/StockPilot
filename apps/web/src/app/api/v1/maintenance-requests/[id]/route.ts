import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError, type ServiceContext } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Whether this org wants a share link folded into the compose email. New
 * setting (Task 11) — `organization_modules.settings` is an unconstrained
 * jsonb blob (0144), so an absent key or a missing row both mean "never
 * configured" and default ON, matching every other module settings reader
 * in this codebase (packages/core/src/b2b/pricing-mode.ts's own precedent).
 * A plain read, not a permission check — the real authorization for MINTING
 * a link still lives entirely in MaintenanceShareLinksService.ensureActiveLink
 * (requester+submit, or manage); this only decides whether the route even
 * asks.
 */
async function shareLinksEnabled(ctx: ServiceContext): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'maintenance_requests')
    .maybeSingle();
  const settings = (data as { settings?: unknown } | null)?.settings as
    | { includeShareLinksInEmail?: boolean }
    | null
    | undefined;
  return settings?.includeShareLinksInEmail !== false;
}

/**
 * Request detail for the mobile app and any REST consumer — the Bearer
 * parity for the web detail page's server load. Assembles three services'
 * output (MaintenanceRequestsService.get, MaintenanceAttachmentsService.
 * signedViewUrls, MaintenanceShareLinksService.ensureActiveLink) into one
 * response; each service still owns its own authorization, this route only
 * composes their results.
 *
 * ensureActiveLink()'s bar for MINTING a link (requester+submit, or manage)
 * is narrower than get()'s bar for VIEWING the request (owner OR read_all
 * OR manage) — a read_all-only holder looking at someone else's request can
 * legitimately see it but is not privileged to hand out a durable public
 * link to it. That mismatch must never fail the WHOLE detail read: any
 * ServiceError out of the share-link step (forbidden, or module_disabled if
 * the module happens to be off — reads survive a disable per 0314 Q3, but
 * ensureActiveLink stays gated) degrades to shareUrl: null instead of
 * propagating. A non-ServiceError (a real bug) still surfaces normally.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // Uuid-validate at the untrusted edge, before it ever reaches a
  // `.eq('id', id)` — a malformed id would otherwise surface as an opaque
  // Postgres 22P02 internal_error instead of a clean 400 (Task 8 convention,
  // matches the sibling attachments routes verbatim).
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    const svc = new MaintenanceRequestsService(ctx);
    const request = await svc.get(id);
    const photos = await new MaintenanceAttachmentsService(ctx).signedViewUrls(id);

    let shareUrl: string | null = null;
    if (request.photoCount > 0 && (await shareLinksEnabled(ctx))) {
      try {
        shareUrl = (await new MaintenanceShareLinksService(ctx).ensureActiveLink(id)).url;
      } catch (shareErr) {
        if (!(shareErr instanceof ServiceError)) throw shareErr;
      }
    }
    const emailInput = await svc.emailInput(id, { shareUrl });

    return NextResponse.json({
      request,
      photos,
      emailInput,
      canManage: can(ctx, 'maintenance_requests:manage'),
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.get' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Partial update. Body is a partial `MaintenanceRequestFormValues` — this
 * route does not re-parse it; MaintenanceRequestsService.update() owns the
 * schema (`.strict().partial()`) AND the field-level requester-vs-manage
 * allow-list (REQUESTER_EDITABLE). This route only validates the id shape
 * and delegates.
 *
 * Because this route forwards the body verbatim, update() is also the ONLY
 * place a patched relatedItemId/relatedOrderRequestId/relatedRentalId/
 * relatedLocationId/charterId/warehouseId (all SIX, as of fix wave 2 / C1 —
 * charterId/warehouseId joined the original four) gets re-derived against
 * this org (resolveRelatedId, fix wave 1) — do not "optimize" that
 * resolution away as redundant with the DB's bare FK, which only proves the
 * row exists somewhere, not that it belongs to this caller's org.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    await new MaintenanceRequestsService(ctx).update(id, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.update' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
