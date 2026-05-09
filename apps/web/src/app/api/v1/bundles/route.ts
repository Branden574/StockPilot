import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile bundle list. Same shape as web's BundleSummary; the mobile
 * snapshot endpoint also includes bundles, but this allows on-demand
 * refresh from the bundles tab.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(req.url);
  const search = url.searchParams.get('q') ?? undefined;
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  try {
    const svc = new BundlesService(ctx);
    const rows = await svc.list({ search, includeInactive });
    return NextResponse.json({ bundles: rows });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
