import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceShareLinksService, maintenanceShareLinksEnabled } from '@/server/services/maintenance-share-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Request detail for the mobile app and any REST consumer — the Bearer
 * parity for the web detail page's server load. Assembles three services'
 * output (MaintenanceRequestsService.get, MaintenanceAttachmentsService.
 * signedViewUrls, MaintenanceShareLinksService.getActiveLinkStatus) into
 * one response; each service still owns its own authorization, this route
 * only composes their results.
 *
 * Mig 0330: the share-link token is hashed at rest, so a GET can no longer
 * fold an existing link's URL into emailInput (and an auto-mint here could
 * only rotate — killing whatever URL was already shared — while still
 * displaying nothing). The response carries `shareLink: { expiresAt } |
 * null` STATUS instead (token-free), plus `emailInput.shareUrl: null`; a
 * client that wants a URL calls POST .../share-link explicitly (show-once,
 * rotates) and merges the returned URL into its compose flow itself.
 *
 * getActiveLinkStatus()'s bar (requester+submit, or manage) is narrower
 * than get()'s bar for VIEWING the request (owner OR read_all OR manage).
 * That mismatch must never fail the WHOLE detail read: any ServiceError
 * out of the share-link step degrades to shareLink: null instead of
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

    let shareLink: { expiresAt: string } | null = null;
    if (request.photoCount > 0 && (await maintenanceShareLinksEnabled(ctx))) {
      try {
        shareLink = await new MaintenanceShareLinksService(ctx).getActiveLinkStatus(id);
      } catch (shareErr) {
        if (!(shareErr instanceof ServiceError)) throw shareErr;
      }
    }
    const { content: emailInput, emailRouting } = await svc.emailInput(id, { shareUrl: null });

    // `emailInput` stays the CONTENT under its shipped key: binaries older
    // than the per-org routing OTA never read `recipients` off it (their
    // compiled core reads the old constants), so they keep today's behavior
    // untouched, while updated clients combine `emailInput` with
    // `emailRouting.recipients` (present only when state === 'valid') and
    // hide the compose actions otherwise.
    return NextResponse.json({
      request,
      photos,
      emailInput,
      emailRouting,
      shareLink,
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
