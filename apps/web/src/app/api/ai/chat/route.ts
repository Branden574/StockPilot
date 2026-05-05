import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { runChat, type ChatTurn } from '@/lib/ai/chat';

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
  history: z.array(turnSchema).max(40).optional(),
});

/**
 * Stateless chat endpoint. Client sends the full prior turn history +
 * new user message; we run the Gemini tool-call loop against the
 * caller's RLS-scoped Supabase client and return the final reply.
 *
 * No streaming yet — first cut is request/response. Streaming with
 * tool calls adds protocol complexity (SSE + intermediate tool-result
 * events) and isn't required for usable latency on Flash (~2-4s
 * typical for a 1-tool answer).
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
    const result = await runChat(
      (payload.history ?? []) as ChatTurn[],
      payload.message,
      ctx,
    );
    return NextResponse.json({
      ok: true,
      reply: result.reply,
      toolCallsUsed: result.toolCallsUsed,
    });
  } catch (err) {
    void reportError(err, {
      tag: 'ai.chat',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'Chat failed.',
      },
      { status: 500 },
    );
  }
}
