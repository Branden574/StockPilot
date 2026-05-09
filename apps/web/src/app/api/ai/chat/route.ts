import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { streamChat, type ChatTurn, type ToolCallRecord } from '@/lib/ai/chat';
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
  sessionId: z.string().uuid().optional(),
  history: z.array(turnSchema).max(40).optional(),
});

/**
 * Streaming chat endpoint. Returns NDJSON — one JSON object per line —
 * so the client can render text as Gemini produces it instead of
 * waiting for the full reply.
 *
 * Event shapes (each is a single line, terminated by \n):
 *   {"type":"text","delta":"..."}
 *   {"type":"tool","name":"...","ok":true}
 *   {"type":"done","sessionId":"...","reply":"...","toolCallsUsed":[...]}
 *   {"type":"error","code":"...","message":"..."}
 *
 * Auth + payload validation still respond with a JSON 4xx (no stream)
 * so the client can branch on Content-Type.
 */
export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Per-user rate limit on the AI chat — protects the org's Gemini
  // quota from a single misbehaving user (or an attacker with a
  // hijacked session) burning through the daily budget. 60 turns/min
  // is well above any human chat cadence.
  const rl = checkRateLimit(`ai-chat:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'Too many AI chat requests. Slow down for a moment.',
        retryAt: rl.resetAt,
      },
      { status: 429 },
    );
  }

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

  // Resolve session + history up front, before streaming starts.
  let sessionId = payload.sessionId ?? null;
  let history: ChatTurn[] = [];

  try {
    if (sessionId) {
      const session = await getSession(ctx, sessionId);
      if (!session) {
        // Stale or expired — start fresh transparently.
        sessionId = null;
      } else {
        const messages = await listMessages(ctx, sessionId);
        history = messages.map((m) => ({ role: m.role, content: m.content }));
      }
    }
    if (!sessionId && payload.history && payload.history.length > 0) {
      history = payload.history as ChatTurn[];
    }
  } catch (err) {
    void reportError(err, { tag: 'ai.chat.prep', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not load chat history.' },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let assembledReply = '';
      const toolCallsUsed: ToolCallRecord[] = [];

      try {
        const iter = streamChat(history, payload.message, ctx);
        // Iterate manually so we can capture the generator's return value
        // (final reply + tool calls) without losing it to a normal
        // for-await consumer.
        while (true) {
          const next = await iter.next();
          if (next.done) {
            assembledReply = next.value.reply;
            // toolCallsUsed yielded events were already pushed; the
            // returned list is authoritative for persistence.
            toolCallsUsed.length = 0;
            for (const t of next.value.toolCallsUsed) toolCallsUsed.push(t);
            break;
          }
          const ev = next.value;
          if (ev.type === 'text') {
            send({ type: 'text', delta: ev.delta });
          } else if (ev.type === 'tool') {
            send({ type: 'tool', name: ev.name, ok: ev.ok });
          }
        }

        // Lazy-create session AFTER successful stream so failed turns
        // don't leave orphan empty sessions in the sidebar.
        let resolvedSessionId = sessionId;
        if (!resolvedSessionId) {
          const session = await createSession(ctx, deriveTitle(payload.message));
          resolvedSessionId = session.id;
        }
        await appendMessages(ctx, resolvedSessionId, [
          { role: 'user', content: payload.message },
          {
            role: 'assistant',
            content: assembledReply,
            toolCalls: toolCallsUsed.map((t) => ({ name: t.name, ok: t.ok })),
          },
        ]);

        send({
          type: 'done',
          sessionId: resolvedSessionId,
          reply: assembledReply,
          toolCallsUsed: toolCallsUsed.map((t) => ({ name: t.name, ok: t.ok })),
        });
      } catch (err) {
        void reportError(err, { tag: 'ai.chat', organizationId: ctx.organizationId });
        const classified = classifyAiError(err);
        send({ type: 'error', code: classified.code, message: classified.userMessage });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Hint to any reverse proxy (e.g. nginx) not to buffer.
      'X-Accel-Buffering': 'no',
    },
  });
}
