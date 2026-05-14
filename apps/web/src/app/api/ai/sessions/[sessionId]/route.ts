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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return NextResponse.json({ error: 'invalid_session_id' }, { status: 400 });
  }
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
  // Validate UUID shape at the route layer so a malformed id can't
  // poison RLS arg-coercion logs with arbitrary user-supplied text.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return NextResponse.json({ error: 'invalid_session_id' }, { status: 400 });
  }
  try {
    const result = await deleteSession(ctx, sessionId);
    if (!result.ok) {
      // Distinguishes "session doesn't exist (or belongs to a different
      // user)" from a real internal failure. Returning 404 here also
      // prevents the silent no-op where a cross-user delete used to
      // 200 cheerfully.
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    void reportError(err, { tag: 'ai.sessions.delete', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Delete failed' },
      { status: 500 },
    );
  }
}
