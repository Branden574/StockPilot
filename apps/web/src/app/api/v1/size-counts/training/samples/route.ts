import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { SizeCountsService } from '@/server/services/size-counts';
import { sizeCountError } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List recent training samples (with signed thumbnail URLs) for the review
 *  grid. Query: ?size=XS (optional), ?limit=N. */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const size = url.searchParams.get('size') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  try {
    const svc = new SizeCountsService(ctx);
    const samples = await svc.listTrainingSamples({
      size: size && size !== 'ALL' ? size : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ ok: true, samples });
  } catch (e) {
    return sizeCountError(e);
  }
}
