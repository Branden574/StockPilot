import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  deleteSession,
  getSession,
  listMessages,
} from '@/lib/ai/sessions';
import { reportError } from '@/lib/error-reporter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET    /api/ai/sessions/:id  — load all messages in a session
 * DELETE /api/ai/sessions/:id  — delete the session (cascade-removes messages)
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { sessionId } = await params;
  try {
    const session = await getSession(ctx, sessionId);
    if (!session) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const messages = await listMessages(ctx, sessionId);
    return NextResponse.json({ ok: true, session, messages });
  } catch (err) {
    void reportError(err, { tag: 'ai.sessions.get', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Load failed' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { sessionId } = await params;
  try {
    await deleteSession(ctx, sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    void reportError(err, { tag: 'ai.sessions.delete', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Delete failed' },
      { status: 500 },
    );
  }
}
