import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { runChat, type ChatTurn } from '@/lib/ai/chat';
import { classifyAiError } from '@/lib/ai/errors';
import {
  appendMessages,
  createSession,
  deriveTitle,
  getSession,
  listMessages,
} from '@/lib/ai/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Tool-call loops can take ~6-15s on large workspaces.
export const maxDuration = 60;

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  /**
   * If supplied, server loads prior messages from this session and
   * persists the new turn into it. If omitted, server creates a fresh
   * session and returns its id so the client can stick with it.
   */
  sessionId: z.string().uuid().optional(),
  /**
   * Legacy fallback only — used when the client is older than the
   * persistence rollout and hasn't picked up sessionId yet. Server
   * still creates a session on the fly so history is captured.
   */
  history: z.array(turnSchema).max(40).optional(),
});

/**
 * Stateful chat endpoint. The conversation is persisted in
 * ai_chat_sessions/ai_chat_messages so refreshing the page no longer
 * wipes context — sessions are retained for 30 days.
 *
 * Server is the source of truth for history; the client only sends the
 * new user message + a session pointer. This avoids drift bugs and
 * means a stale tab can't poison the conversation.
 */
export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: err instanceof Error ? err.message : 'Invalid payload',
      },
      { status: 400 },
    );
  }

  try {
    let sessionId = payload.sessionId ?? null;
    let history: ChatTurn[] = [];
    let isNewSession = false;

    if (sessionId) {
      const session = await getSession(ctx, sessionId);
      if (!session) {
        // The id was unknown or expired — start a new session
        // transparently rather than 404'ing the user mid-typing.
        sessionId = null;
      } else {
        const messages = await listMessages(ctx, sessionId);
        history = messages.map((m) => ({ role: m.role, content: m.content }));
      }
    }

    if (!sessionId) {
      // Honor a client-supplied legacy history when starting fresh, so
      // a long pre-rollout conversation isn't visually truncated.
      if (payload.history && payload.history.length > 0) {
        history = payload.history as ChatTurn[];
      }
    }

    const result = await runChat(history, payload.message, ctx);

    // Lazy-create the session AFTER runChat succeeds. Earlier we created
    // it up front, but if Gemini threw (e.g. credits depleted) the row
    // got stranded with zero messages — orphans cluttered the sidebar.
    if (!sessionId) {
      const session = await createSession(ctx, deriveTitle(payload.message));
      sessionId = session.id;
      isNewSession = true;
    }

    await appendMessages(ctx, sessionId, [
      { role: 'user', content: payload.message },
      {
        role: 'assistant',
        content: result.reply,
        toolCalls: result.toolCallsUsed.map((t) => ({ name: t.name, ok: t.ok })),
      },
    ]);

    return NextResponse.json({
      ok: true,
      sessionId,
      isNewSession,
      reply: result.reply,
      toolCallsUsed: result.toolCallsUsed,
    });
  } catch (err) {
    // Always log the raw error server-side — admins need the full
    // detail (URLs, model name, status codes) to diagnose. Clients
    // get a clean classified message only.
    void reportError(err, {
      tag: 'ai.chat',
      organizationId: ctx.organizationId,
    });
    const classified = classifyAiError(err);
    return NextResponse.json(
      {
        error: classified.code,
        message: classified.userMessage,
      },
      { status: classified.status },
    );
  }
}
