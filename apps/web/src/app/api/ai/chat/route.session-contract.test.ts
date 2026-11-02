import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { streamChatClaude } from '@/lib/ai/chat-claude';
import { appendMessages, createSession, getSession, listMessages } from '@/lib/ai/sessions';
import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

/**
 * How a chat keeps its session, and what a request that names one may carry
 * (docket B75).
 *
 * The route answers from the session's own stored turns whenever the request
 * names a session it can read, and reads the client's `history` only for a
 * request without one. Yet the schema checked that history first, and refused
 * it past 40 turns or a turn over 8,000 characters. Every phone build before
 * B75 sends its whole on-screen transcript with every message (apps/mobile/
 * app/ai/chat.tsx), so once such a phone held a session, about the 22nd
 * message of a chat was refused, and every message after a reply over 8,000
 * characters, for a history the route would not have read. And none held one:
 * those builds adopt the id from a `session` event that nothing sent (the
 * route named the session only in its last event, `done`), so each phone
 * message started a chat of its own in the person's list.
 *
 * Pinned here: a request that names a session is read without its history, and
 * every answer names its session first, then again in `done`. A request
 * without a session id keeps every check (S16's refusals, route.refusals.test.ts).
 */

const { HELD, NEW } = vi.hoisted(() => ({
  HELD: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  NEW: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/sessions', () => ({
  appendMessages: vi.fn(async () => undefined),
  createSession: vi.fn(async () => ({ id: NEW })),
  deriveTitle: vi.fn(() => 'title'),
  getSession: vi.fn(async (_ctx: unknown, id: string) =>
    id === HELD
      ? {
          id: HELD,
          title: 'Earlier chat',
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-01T00:00:00Z',
        }
      : null,
  ),
  listMessages: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/chat', () => ({ buildOrgSnapshot: vi.fn(async () => ''), streamChat: vi.fn() }));
vi.mock('@/lib/ai/chat-claude', () => ({ streamChatClaude: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));

type Turn = { role: 'user' | 'assistant'; content: string };

/** The phone's history: its whole on-screen transcript, user and assistant turns. */
function transcript(turns: number, length = 20): Turn[] {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(length),
  }));
}

/** The session's own stored turns, oldest first, as listMessages returns them. */
function stored(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as Turn['role'],
    content: `stored turn ${i}`,
    toolCalls: null,
    createdAt: '2026-11-01T00:00:00Z',
  }));
}

/** The history each model call received. */
let modelHistories: Turn[][] = [];

function chat(body: unknown) {
  return new Request('https://test.local/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answer(body: unknown) {
  const res = await POST(chat(body));
  const text = await res.text();
  const events =
    res.status === 200
      ? text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { status: res.status, text, events };
}

const doneOf = (events: Record<string, unknown>[]) => events.find((e) => e.type === 'done');

describe('POST /api/ai/chat: a chat keeps its session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelHistories = [];
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
    vi.mocked(listMessages).mockResolvedValue(stored(6));
    vi.mocked(streamChatClaude).mockImplementation(async function* (history: Turn[]) {
      modelHistories.push(history);
      yield { type: 'text', delta: 'Here is the answer.' } as const;
      return { reply: 'Here is the answer.', toolCallsUsed: [] };
    } as unknown as typeof streamChatClaude);
  });

  it("a held session with 42 turns of history (every installed phone from about its 22nd message) is answered from the session's stored turns", async () => {
    const r = await answer({ message: 'next question', sessionId: HELD, history: transcript(42) });

    expect(r.status, r.text).toBe(200);
    expect(modelHistories).toEqual([stored(6).map((m) => ({ role: m.role, content: m.content }))]);
    expect(doneOf(r.events)).toMatchObject({ type: 'done', sessionId: HELD });
    expect(createSession).not.toHaveBeenCalled();
    expect(vi.mocked(appendMessages).mock.calls.map((c) => c[1])).toEqual([HELD, HELD]);
  });

  it('a held session with a history turn of 9,000 characters (a long reply the phone resends) is answered', async () => {
    const history = [...transcript(1), { role: 'assistant', content: 'r'.repeat(9000) }];
    const r = await answer({ message: 'and then?', sessionId: HELD, history });

    expect(r.status, r.text).toBe(200);
    expect(doneOf(r.events)).toMatchObject({ sessionId: HELD });
  });

  it("every answer names its session first, before any text, and again in done: the new chat's id, or the held one", async () => {
    for (const [body, id] of [
      [{ message: 'first question' }, NEW],
      [{ message: 'follow-up', sessionId: HELD }, HELD],
    ] as const) {
      const r = await answer(body);
      expect(r.status, r.text).toBe(200);
      expect(r.events[0], JSON.stringify(body)).toEqual({ type: 'session', id });
      expect(r.events.findIndex((e) => e.type === 'text')).toBeGreaterThan(0);
      expect(r.events.at(-1)).toMatchObject({ type: 'done', sessionId: id });
    }
  });

  it('without a session id, a new session is created and done carries its id', async () => {
    const r = await answer({ message: 'first question' });

    expect(r.status, r.text).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
    expect(doneOf(r.events)).toMatchObject({ type: 'done', sessionId: NEW });
    expect(modelHistories).toEqual([[]]);
  });

  it('a held session with 45 stored messages gives the model the newest 40', async () => {
    vi.mocked(listMessages).mockResolvedValue(stored(45));
    const r = await answer({ message: 'next', sessionId: HELD });

    expect(r.status, r.text).toBe(200);
    expect(modelHistories).toEqual([
      stored(45)
        .slice(-40)
        .map((m) => ({ role: m.role, content: m.content })),
    ]);
  });

  it('a session that is gone (deleted, or idle 30 days) starts a new chat, and both events carry the new id', async () => {
    const gone = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const r = await answer({ message: 'still there?', sessionId: gone });

    expect(r.status, r.text).toBe(200);
    expect(getSession).toHaveBeenCalledWith(expect.anything(), gone);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(r.events[0]).toEqual({ type: 'session', id: NEW });
    expect(doneOf(r.events)).toMatchObject({ sessionId: NEW });
  });

  it("the client's history sent beside a session that is gone is not read: the new chat starts with none, as on the web", async () => {
    const gone = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const r = await answer({ message: 'still there?', sessionId: gone, history: transcript(4) });

    expect(r.status, r.text).toBe(200);
    expect(modelHistories).toEqual([[]]);
  });

  it("S16's refusals are unchanged: no session id with 42 turns, a session id that is not a UUID, a message over 2,000 characters", async () => {
    const cases: [unknown, string][] = [
      [
        { message: 'next question', history: transcript(42) },
        'This conversation is too long. Start a new chat.',
      ],
      [{ message: 'hi', sessionId: 'not-a-uuid' }, 'The request could not be read.'],
      [
        { message: 'hi', sessionId: 'not-a-uuid', history: transcript(42) },
        'The request could not be read.',
      ],
      [
        { message: 'm'.repeat(2001), sessionId: HELD },
        'Your message is too long. Keep it under 2,000 characters.',
      ],
    ];
    for (const [body, message] of cases) {
      const r = await answer(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(JSON.parse(r.text)).toEqual({ error: 'validation_error', message });
    }
    expect(streamChatClaude).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
