import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { serviceErrorResponse } from '@/server/lib/service-error-response';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id, attachmentId } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }
  if (!z.string().uuid().safeParse(attachmentId).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That photo id is not valid.' }, { status: 400 });
  }

  try {
    await new MaintenanceAttachmentsService(ctx).remove(id, attachmentId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.maintenance-requests.attachments.delete');
  }
}
