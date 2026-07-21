import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { SizeCountsService } from '@/server/services/size-counts';
import { sizeCountError } from '../../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Delete one training sample (row + storage object). Manager-gated. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  try {
    const svc = new SizeCountsService(ctx);
    await svc.deleteTrainingSample(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return sizeCountError(e);
  }
}
