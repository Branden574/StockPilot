import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ConnectionsService } from '@/server/services/connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const svc = new ConnectionsService(ctx);
    await svc.disconnect('zendesk');
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status = e.code === 'module_disabled' || e.code === 'forbidden' ? 403 : e.code === 'not_found' ? 404 : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
