import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { createSession, listSessions } from '@/lib/ai/sessions';
import { reportError } from '@/lib/error-reporter';

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
    void reportError(err, { tag: 'ai.sessions.list', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'List failed' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const session = await createSession(ctx);
    return NextResponse.json({ ok: true, session });
  } catch (err) {
    void reportError(err, { tag: 'ai.sessions.create', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Create failed' },
      { status: 500 },
    );
  }
}
