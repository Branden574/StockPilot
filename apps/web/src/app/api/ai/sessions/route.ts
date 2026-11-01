import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { createSession, listSessions } from '@/lib/ai/sessions';
import { internalErrorResponse } from '@/server/lib/api-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/ai/sessions       — list this user's chat sessions (≤30d)
 * POST /api/ai/sessions       — create an empty session, return its id
 */

export async function GET(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const sessions = await listSessions(ctx);
    return NextResponse.json({ ok: true, sessions });
  } catch (err) {
    return internalErrorResponse(err, 'ai.sessions.list', { organizationId: ctx.organizationId });
  }
}

export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const session = await createSession(ctx);
    return NextResponse.json({ ok: true, session });
  } catch (err) {
    return internalErrorResponse(err, 'ai.sessions.create', { organizationId: ctx.organizationId });
  }
}
