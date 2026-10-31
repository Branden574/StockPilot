import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { deleteSession, getSession, listMessages } from '@/lib/ai/sessions';
import { reportError } from '@/lib/error-reporter';

import { DELETE, GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/sessions', () => ({
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  listMessages: vi.fn(),
}));

/**
 * GET/DELETE /api/ai/sessions/:id (S16). lib/ai/sessions.ts throws the
 * database's own text: a failure used to answer it. It is reported, as
 * before, and the answer is the fixed sentence.
 */

const SESSION = '44444444-4444-4444-8444-444444444444';
const call = (handler: typeof GET, method: 'GET' | 'DELETE') =>
  handler(new Request(`https://test.local/api/ai/sessions/${SESSION}`, { method }), {
    params: Promise.resolve({ sessionId: SESSION }),
  });

const DB_TEXT = 'relation "ai_chat_messages" does not exist';

describe('/api/ai/sessions/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
    } as never);
  });

  it('loads and deletes as before', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION } as never);
    vi.mocked(listMessages).mockResolvedValueOnce([] as never);
    expect(await (await call(GET, 'GET')).json()).toEqual({
      ok: true,
      session: { id: SESSION },
      messages: [],
    });
    vi.mocked(deleteSession).mockResolvedValueOnce({ ok: true } as never);
    expect(await (await call(DELETE, 'DELETE')).json()).toEqual({ ok: true });
  });

  it.each([
    ['GET', 'ai.sessions.get'],
    ['DELETE', 'ai.sessions.delete'],
  ] as const)(
    'a failed %s answers the fixed sentence, never the database text, and is reported',
    async (method, tag) => {
      const err = new Error(DB_TEXT);
      vi.mocked(getSession).mockRejectedValueOnce(err);
      vi.mocked(deleteSession).mockRejectedValueOnce(err);
      const res = await call(method === 'GET' ? GET : DELETE, method);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'internal_error',
        message: 'Something went wrong. Please try again.',
      });
      expect(text).not.toContain('ai_chat_messages');
      expect(reportError).toHaveBeenCalledWith(err, { tag, organizationId: 'org-1' });
    },
  );
});
