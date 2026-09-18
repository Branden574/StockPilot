// @vitest-environment node
// Node, not the DOM project this path would default to: a browser-like Request
// silently DROPS the forbidden `Origin` header, which would make the cross-site
// test pass or fail for the wrong reason. The route runs on Node in production.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { recordReleaseState } from '@/server/services/releases';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/releases', () => ({ recordReleaseState: vi.fn() }));

const ctx = { organizationId: 'org-1', userId: 'user-1', role: 'staff' } as never;

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://stockpilotusa.com/api/v1/me/release-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx);
  vi.mocked(recordReleaseState).mockResolvedValue({ ok: true, recorded: 1 });
});

describe('POST /api/v1/me/release-state', () => {
  it('records the action for the session’s own user', async () => {
    const res = await POST(req({ action: 'read', releaseId: 'september-2026' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 1 });
    expect(recordReleaseState).toHaveBeenCalledWith(ctx, {
      action: 'read',
      releaseId: 'september-2026',
    });
  });

  it('refuses a body that tries to name a user or a revision', async () => {
    for (const body of [
      { action: 'read', releaseId: 'september-2026', userId: 'someone-else' },
      { action: 'read', releaseId: 'september-2026', revision: 99 },
      { action: 'unread', releaseId: 'september-2026' },
      { action: 'read', releaseId: '../../etc' },
      { action: 'read' },
      'not json',
    ]) {
      const res = await POST(req(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(recordReleaseState).not.toHaveBeenCalled();
  });

  it('answers 401 with no session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await POST(req({ action: 'read_all' }))).status).toBe(401);
    expect(recordReleaseState).not.toHaveBeenCalled();
  });

  it('refuses a cookie POST from another site, before looking at the session', async () => {
    const res = await POST(req({ action: 'read_all' }, { Origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(withApiContext).not.toHaveBeenCalled();
  });

  it('accepts same-origin, no Origin at all, and a Bearer caller whatever its Origin', async () => {
    expect(
      (await POST(req({ action: 'read_all' }, { Origin: 'https://stockpilotusa.com' }))).status,
    ).toBe(200);
    expect((await POST(req({ action: 'read_all' }))).status).toBe(200);
    expect(
      (
        await POST(
          req(
            { action: 'read_all' },
            { Origin: 'https://evil.example', Authorization: 'Bearer token' },
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('says so when the state was NOT saved, instead of claiming success', async () => {
    vi.mocked(recordReleaseState).mockResolvedValue({ ok: false });
    const res = await POST(req({ action: 'read', releaseId: 'september-2026' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('is never cached', async () => {
    expect((await POST(req({ action: 'read_all' }))).headers.get('Cache-Control')).toBe(
      'private, no-store',
    );
  });
});
