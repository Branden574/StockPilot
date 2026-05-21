import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { hasPermission } from '@/lib/auth/permissions';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { buildOrgSnapshot, streamChat, type ChatTurn, type ToolCallRecord } from '@/lib/ai/chat';
import { classifyAiError } from '@/lib/ai/errors';
import { classifyIntent, intentNudge } from '@/lib/ai/intent';
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

// `history` is bounded to keep prompt tokens predictable; streamChat
// caps internally too. `sessionId` is a UUID (zod enforces format),
// which also satisfies the "validate sessionId at route level" item.
//
// `pageContext` is a lightweight hint about where the user came from
// (the dashboard route they opened the AI chat from). We use it to
// surface the on-page entity ID — order, item, book, PO — to the
// model so "what's the next step for this order?" doesn't require
// the user to re-paste the UUID. Strict shape: just a path string,
// further parsed server-side against a fixed regex allowlist. We
// never trust free-form text from this field.
const pageContextSchema = z.object({
  /** Pathname of the page the user opened the chat from, e.g.
   *  "/dashboard/orders/abc-uuid". Hard-capped so a malicious tab
   *  can't smuggle a 1MB payload into the prompt. */
  referrerPath: z.string().max(200).optional(),
});
const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().uuid().optional(),
  history: z.array(turnSchema).max(40).optional(),
  pageContext: pageContextSchema.optional(),
});

/**
 * Pull a known entity reference out of a referrer path. We allowlist
 * the exact route shapes we know about — anything else is dropped.
 * The UUID itself is validated against a strict regex, so the model
 * never sees attacker-controlled text from this code path.
 */
function extractEntityHint(
  referrerPath: string | undefined,
): { kind: string; id: string; routeLabel: string } | null {
  if (!referrerPath) return null;
  const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  const matchers: Array<{ kind: string; routeLabel: string; re: RegExp }> = [
    { kind: 'order_request', routeLabel: 'order detail', re: new RegExp(`^/dashboard/orders/(${UUID_RE})(?:/|$)`) },
    { kind: 'inventory_item', routeLabel: 'item detail', re: new RegExp(`^/dashboard/inventory/(${UUID_RE})(?:/|$)`) },
    { kind: 'inventory_item', routeLabel: 'book detail', re: new RegExp(`^/dashboard/books/(${UUID_RE})(?:/|$)`) },
    { kind: 'purchase_order', routeLabel: 'PO detail', re: new RegExp(`^/dashboard/purchase-orders/(${UUID_RE})(?:/|$)`) },
    { kind: 'warehouse', routeLabel: 'warehouse detail', re: new RegExp(`^/dashboard/admin/warehouses/(${UUID_RE})(?:/|$)`) },
    { kind: 'cycle_count', routeLabel: 'cycle count detail', re: new RegExp(`^/dashboard/cycle-counts/(${UUID_RE})(?:/|$)`) },
  ];
  for (const m of matchers) {
    const hit = referrerPath.match(m.re);
    if (hit) return { kind: m.kind, id: hit[1]!, routeLabel: m.routeLabel };
  }
  return null;
}

// Mirrors the streamChat history cap. Kept here as well so that any
// DB-loaded history is trimmed before being passed in.
const MAX_HISTORY_TURNS = 40;

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

  // Route-level role gate. The write tools each assertPermission too,
  // but viewers can still spend Gemini tokens by chatting read-only —
  // this endpoint is staff+ only so we don't have to rely on tool-by-
  // tool gating alone. We use 'items:update' as the minimum write
  // capability: staff/manager/admin/owner all have it; viewers do not.
  if (!hasPermission(ctx.role, 'items:update')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Per-user rate limit on the AI chat — protects the org's Gemini
  // quota from a single misbehaving user (or an attacker with a
  // hijacked session) burning through the daily budget. 60 turns/min
  // is well above any human chat cadence.
  const rl = await checkRateLimit(`ai-chat:${ctx.userId}`, 60, 60_000);
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

  // Per-ORG daily cap. A single user is bounded by the per-user limit
  // above, but an org with 50 staff can still pile on. 1,000 chat
  // turns per org per day is plenty for any sensible internal use and
  // hard-stops accidental token-spend explosions.
  const orgRl = await checkRateLimit(
    `ai-chat-org:${ctx.organizationId}`,
    1000,
    24 * 60 * 60 * 1000,
  );
  if (!orgRl.allowed) {
    return NextResponse.json(
      {
        error: 'rate_limited_org',
        message:
          'Your organization has hit its daily AI chat limit. It resets in 24 hours.',
        retryAt: orgRl.resetAt,
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
    // Cap whatever we ended up with (DB-loaded or client-sent) — even
    // though the DB layer caps at 60 messages and the client zod
    // schema caps at 40 turns, both paths funnel through this single
    // gate so a future regression in either source still won't blow
    // past the token budget.
    if (history.length > MAX_HISTORY_TURNS) {
      history = history.slice(-MAX_HISTORY_TURNS);
    }
  } catch (err) {
    void reportError(err, { tag: 'ai.chat.prep', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not load chat history.' },
      { status: 500 },
    );
  }

  // Lazy-create the session BEFORE streaming starts so the user turn
  // can be persisted up front. If the stream blows up mid-flight we
  // still have a paper trail of what the user asked. The assistant
  // turn (partial or complete) is persisted in the finally below.
  let resolvedSessionId = sessionId;
  try {
    if (!resolvedSessionId) {
      const session = await createSession(ctx, deriveTitle(payload.message));
      resolvedSessionId = session.id;
    }
    await appendMessages(ctx, resolvedSessionId, [
      { role: 'user', content: payload.message },
    ]);
  } catch (err) {
    void reportError(err, {
      tag: 'ai.chat.persist-user',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not save your message.' },
      { status: 500 },
    );
  }

  // After this point we MUST always send a `done` event before closing
  // the stream — the client uses it as the terminator. Errors are
  // sent as `error` events, then `done` follows.
  const finalSessionId = resolvedSessionId;
  const turnStartMs = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        // controller.desiredSize === null means the consumer (client)
        // cancelled the stream — avoid pushing more bytes into a
        // closed queue, which can throw and abort our finally cleanup.
        if (controller.desiredSize === null) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client disconnected mid-write. Swallow — finally still runs.
        }
      };

      let assembledReply = '';
      const toolCallsUsed: ToolCallRecord[] = [];
      let errorEvent: Record<string, unknown> | null = null;
      // Captured by the snapshot-building block below so the finally
      // log can include it. Default to 'general' if classification
      // fails for any reason — we still want a metric line per turn.
      let intentForObservability: string = 'general';

      try {
        // Thread the request's AbortSignal into the chat loop so a
        // client disconnect propagates all the way down to Gemini and
        // the tool calls. Without this, the model keeps generating
        // (and burning quota) after the user navigates away.
        // Compute the org snapshot once per turn and prepend it to the
        // system prompt so basic stats ("how many active items", "low
        // stock count", "movements today") answer instantly without
        // burning a tool call. Failures are swallowed inside the helper.
        const orgSnapshot = await buildOrgSnapshot(ctx);
        // Build USER + PAGE CONTEXT blocks alongside the org snapshot.
        // Page context comes from a strict route allowlist
        // (extractEntityHint) — never free-form text from the client —
        // so it's safe to drop straight into the system prompt without
        // the <data> injection-defense wrapper.
        const entityHint = extractEntityHint(payload.pageContext?.referrerPath);
        const userBlock = [
          '— USER —',
          `Role: ${ctx.role}`,
          'Permissions follow standard role rules. Write tools enforce',
          'them server-side; do not assume you can perform actions the',
          'role cannot. If asked to do something out of scope for this',
          'role, explain who CAN do it instead.',
        ].join('\n');
        const pageBlock = entityHint
          ? [
              '— PAGE CONTEXT —',
              `The user opened this chat from the ${entityHint.routeLabel} page.`,
              `Entity in focus: ${entityHint.kind} id="${entityHint.id}"`,
              'When the user asks an ambiguous question that could refer to',
              "this entity (\"what's next?\", \"is it ready?\", \"show the",
              'timeline", "who is assigned?"), assume they mean THIS entity',
              'unless they clearly name a different one. Pass this id to',
              'the relevant tool (getOrderRequestSummary, getItemDetails,',
              'etc.) instead of asking the user to repaste it.',
            ].join('\n')
          : '';
        // Cheap rule-based intent classifier (zero added latency).
        // Surfaces a short tool-priority nudge so Gemini picks the
        // right tool on the first hop. Wrong/general intent is safe —
        // the nudge is just a hint, the full tool catalog is still
        // available.
        const intent = classifyIntent(payload.message);
        intentForObservability = intent;
        const intentBlock = intentNudge(intent);
        const snapshot = [orgSnapshot, userBlock, pageBlock, intentBlock]
          .filter(Boolean)
          .join('\n\n');
        const iter = streamChat(history, payload.message, ctx, {
          signal: req.signal,
          snapshot,
        });
        // Iterate manually so we can capture the generator's return value
        // (final reply + tool calls) without losing it to a normal
        // for-await consumer.
        while (true) {
          if (req.signal.aborted) break;
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
      } catch (err) {
        void reportError(err, { tag: 'ai.chat', organizationId: ctx.organizationId });
        const classified = classifyAiError(err);
        errorEvent = {
          type: 'error',
          code: classified.code,
          message: classified.userMessage,
        };
      } finally {
        // Always persist the assistant turn — even a partial reply —
        // so the user can see what was attempted. Wrapped in its own
        // try/catch so a persistence failure doesn't swallow the
        // `done` event the client is waiting for.
        if (assembledReply || toolCallsUsed.length > 0) {
          try {
            await appendMessages(ctx, finalSessionId, [
              {
                role: 'assistant',
                content: assembledReply || '[no response]',
                toolCalls: toolCallsUsed.map((t) => ({ name: t.name, ok: t.ok })),
              },
            ]);
          } catch (persistErr) {
            void reportError(persistErr, {
              tag: 'ai.chat.persist-assistant',
              organizationId: ctx.organizationId,
            });
            // Don't escalate — the user's message is already saved and
            // the stream still terminates cleanly below.
          }
        }

        if (errorEvent) send(errorEvent);
        send({
          type: 'done',
          sessionId: finalSessionId,
          reply: assembledReply,
          toolCallsUsed: toolCallsUsed.map((t) => ({ name: t.name, ok: t.ok })),
        });
        // Structured per-turn observability log — picked up by Vercel
        // logs and any log aggregator that ingests them. One line per
        // turn so it's grep-friendly. Don't write to a DB table here:
        // adds latency + an extra failure mode, and stdout is enough
        // for the kinds of analysis we'd run (latency distributions,
        // error rates, intent coverage, tool-call cardinality).
        try {
          const durationMs = Date.now() - turnStartMs;
          const okCalls = toolCallsUsed.filter((t) => t.ok).length;
          const failCalls = toolCallsUsed.length - okCalls;
          const failedTools = toolCallsUsed
            .filter((t) => !t.ok)
            .map((t) => t.name);
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              level: 'info',
              tag: 'ai.chat.turn',
              organizationId: ctx.organizationId,
              userId: ctx.userId,
              sessionId: finalSessionId,
              intent: intentForObservability,
              durationMs,
              toolCallCount: toolCallsUsed.length,
              toolCallsOk: okCalls,
              toolCallsFailed: failCalls,
              failedTools: failedTools.length > 0 ? failedTools : undefined,
              toolNames: toolCallsUsed.map((t) => t.name),
              replyLen: assembledReply.length,
              errored: !!errorEvent,
              errorCode:
                errorEvent && typeof errorEvent.code === 'string'
                  ? errorEvent.code
                  : undefined,
            }),
          );
        } catch {
          // Logging must never break the response — swallow any
          // accidental JSON.stringify cycle errors.
        }
        try {
          controller.close();
        } catch {
          // Already closed — fine.
        }
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
