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

/**
 * What the web app's own fetch sends (lib/updates/update-store.ts): a browser
 * puts its page's origin on every write. Pass other headers to replace them,
 * or {} for a write with neither.
 */
const PAGE = { Origin: 'https://stockpilotusa.com', 'Sec-Fetch-Site': 'same-origin' };

function req(body: unknown, headers: Record<string, string> = PAGE) {
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

  it.each([
    ['Sec-Fetch-Site cross-site, with no Origin', { 'Sec-Fetch-Site': 'cross-site' }],
    [
      'Sec-Fetch-Site same-site from a sibling subdomain',
      { 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.stockpilotusa.com' },
    ],
    ['Sec-Fetch-Site none (no page made it)', { 'Sec-Fetch-Site': 'none' }],
    [
      'a Basic Authorization header, which is not a bearer',
      { Authorization: 'Basic dXNlcjpwYXNz', Origin: 'https://evil.example' },
    ],
  ])('refuses %s with the same 403 (the shared rule, docket S14)', async (_name, headers) => {
    const res = await POST(req({ action: 'read_all' }, headers));
    expect(res.status).toBe(403);
    expect(withApiContext).not.toHaveBeenCalled();
    expect(recordReleaseState).not.toHaveBeenCalled();
  });

  it('refuses a cookie POST with neither Origin nor Sec-Fetch-Site with the same 403 (fail closed, docket S14)', async () => {
    const res = await POST(req({ action: 'read_all' }, {}));
    expect(res.status).toBe(403);
    expect(withApiContext).not.toHaveBeenCalled();
    expect(recordReleaseState).not.toHaveBeenCalled();
  });

  it("accepts the page's own post, a matching Origin alone, and a Bearer caller whatever its headers", async () => {
    expect((await POST(req({ action: 'read_all' }))).status).toBe(200);
    expect(
      (await POST(req({ action: 'read_all' }, { Origin: 'https://stockpilotusa.com' }))).status,
    ).toBe(200);
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
    expect(
      (await POST(req({ action: 'read_all' }, { Authorization: 'Bearer token' }))).status,
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
