import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ConnectionsService } from '@/server/services/connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  subdomain: z.string().min(1).max(120),
  email: z.string().email().max(254),
  apiToken: z.string().min(1).max(512),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }
    const svc = new ConnectionsService(ctx);
    await svc.connectZendesk(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status = e.code === 'module_disabled' || e.code === 'forbidden' ? 403 : e.code === 'validation_error' ? 400 : e.code === 'not_found' ? 404 : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
