import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

/**
 * What the AI chat answers when the request's body is refused, before any
 * model call (S16 review).
 *
 * The answer used to be the ZodError's own text, its issue list as JSON. S16
 * replaced it with "The request could not be read." for every refusal, and
 * the phone hits two of them in normal use: it sends the whole transcript as
 * `history` with every message (app/ai/chat.tsx), and the schema caps that
 * at 40 turns of at most 8,000 characters, so about the 22nd message of a
 * chat is refused, as is every message after a reply over 8,000 characters.
 * The web chat box has no length cap. Those refusals now say what to do, in
 * the app's words; a body that is not JSON, or any other refusal, keeps the
 * fixed sentence. None of them carries the parser's text.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/sessions', () => ({
  appendMessages: vi.fn(async () => {
    throw new Error('a refused request must not be saved');
  }),
  createSession: vi.fn(async () => {
    throw new Error('a refused request must not start a session');
  }),
  deriveTitle: vi.fn(() => 'title'),
  getSession: vi.fn(async () => null),
  listMessages: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/chat', () => ({ buildOrgSnapshot: vi.fn(), streamChat: vi.fn() }));
vi.mock('@/lib/ai/chat-claude', () => ({ streamChatClaude: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));

const MESSAGE_TOO_LONG = 'Your message is too long. Keep it under 2,000 characters.';
const CONVERSATION_TOO_LONG = 'This conversation is too long. Start a new chat.';
const UNREADABLE = 'The request could not be read.';

function chat(body: string) {
  return new Request('https://test.local/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** The phone's history: the whole on-screen transcript, user and assistant turns. */
function transcript(turns: number, length = 20) {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(length),
  }));
}

async function refusal(body: string) {
  const res = await POST(chat(body));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('POST /api/ai/chat refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({}).client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['ai']),
    } as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    } as never);
  });

  it('a message over 2,000 characters says so', async () => {
    const r = await refusal(JSON.stringify({ message: 'm'.repeat(2001) }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'validation_error', message: MESSAGE_TOO_LONG });
  });

  it("the phone's 22nd message (42 turns of history) says to start a new chat", async () => {
    const r = await refusal(JSON.stringify({ message: 'next question', history: transcript(42) }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'validation_error', message: CONVERSATION_TOO_LONG });
  });

  it('a reply over 8,000 characters in the history says to start a new chat', async () => {
    const history = [...transcript(1), { role: 'assistant', content: 'r'.repeat(8001) }];
    const r = await refusal(JSON.stringify({ message: 'and then?', history }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'validation_error', message: CONVERSATION_TOO_LONG });
  });

  it('40 turns of history is still accepted (the schema cap, not one less)', async () => {
    // Past the schema, the route goes on to save the turn; the sessions
    // stub refuses that, so a 500 here means the body was accepted.
    const res = await POST(chat(JSON.stringify({ message: 'ok', history: transcript(40) })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Could not save your message.',
    });
  });

  it('a body that is not JSON, or any other refusal, keeps the fixed sentence', async () => {
    for (const body of [
      '{"message": "cut sho',
      JSON.stringify({ message: 'hi', sessionId: 'not-a-uuid' }),
      JSON.stringify({ message: '' }),
      JSON.stringify({ message: 'hi', history: [{ role: 'system', content: 'x' }] }),
    ]) {
      const r = await refusal(body);
      expect(r.status, body).toBe(400);
      expect(r.body, body).toEqual({ error: 'validation_error', message: UNREADABLE });
    }
  });

  it("never answers the parser's own text, and reports nothing: the body is the caller's", async () => {
    for (const body of [
      JSON.stringify({ message: 'm'.repeat(2001) }),
      JSON.stringify({ message: 'q', history: transcript(42) }),
      JSON.stringify({ message: 'hi', sessionId: 'not-a-uuid' }),
      '{"message": "cut sho',
    ]) {
      const r = await refusal(body);
      for (const parserText of ['too_big', 'invalid_string', '"path"', 'maximum', 'JSON']) {
        expect(r.text, body).not.toContain(parserText);
      }
    }
    expect(reportError).not.toHaveBeenCalled();
  });
});
