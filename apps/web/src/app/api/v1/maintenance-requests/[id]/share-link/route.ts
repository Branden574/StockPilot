import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ensure (mint-or-return) the active share link for this request.
 *
 * Response is deliberately `{ url, expiresAt }` ONLY — never the raw
 * `token` field MaintenanceShareLinksService.ensureActiveLink() also
 * returns. The url already embeds the token (`${APP_URL}/m/${token}`);
 * echoing it back a second time as a bare field would just be a second,
 * easier-to-misuse place for the credential to leak into logs/analytics
 * that only meant to capture "a url was returned".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    const link = await new MaintenanceShareLinksService(ctx).ensureActiveLink(id);
    return NextResponse.json({ url: link.url, expiresAt: link.expiresAt });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.share-link.ensure' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/** Revoke the request's active share link. manage-only (service-enforced). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    await new MaintenanceShareLinksService(ctx).revoke(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.share-link.revoke' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
