import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { createSession, listSessions } from '@/lib/ai/sessions';
import { reportError } from '@/lib/error-reporter';

import { GET, POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/sessions', () => ({ createSession: vi.fn(), listSessions: vi.fn() }));

/**
 * GET/POST /api/ai/sessions (S16). lib/ai/sessions.ts throws the database's
 * own text (`new Error(error.message)`): a failure used to answer it to the
 * chat panel. It is reported, as before, and the answer is the fixed sentence.
 */

const request = (method: 'GET' | 'POST') =>
  new Request('https://test.local/api/ai/sessions', { method });

const DB_TEXT = 'permission denied for table ai_chat_sessions';

describe('/api/ai/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
    } as never);
  });

  it('lists and creates as before', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([] as never);
    expect(await (await GET(request('GET'))).json()).toEqual({ ok: true, sessions: [] });
    vi.mocked(createSession).mockResolvedValueOnce({ id: 's-1' } as never);
    expect(await (await POST(request('POST'))).json()).toEqual({
      ok: true,
      session: { id: 's-1' },
    });
  });

  it.each([
    ['GET', 'ai.sessions.list'],
    ['POST', 'ai.sessions.create'],
  ] as const)(
    'a failed %s answers the fixed sentence, never the database text, and is reported',
    async (method, tag) => {
      const err = new Error(DB_TEXT);
      vi.mocked(listSessions).mockRejectedValueOnce(err);
      vi.mocked(createSession).mockRejectedValueOnce(err);
      const res = await (method === 'GET' ? GET : POST)(request(method));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'internal_error',
        message: 'Something went wrong. Please try again.',
      });
      expect(text).not.toContain('ai_chat_sessions');
      expect(reportError).toHaveBeenCalledWith(err, { tag, organizationId: 'org-1' });
    },
  );
});
