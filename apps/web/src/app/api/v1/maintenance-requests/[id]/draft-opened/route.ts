import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Records that the Outlook draft WAS OPENED — nothing more is knowable
 * (brief §20/21): StockPilot cannot observe Send, delivery, or Zendesk
 * ticket creation, so this response — and every surface that renders it —
 * must stay confined to that one fact. Never 'sent', never 'ticket created'.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened(id);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.draft-opened' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
