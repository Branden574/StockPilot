import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getReleaseFor, listReleasesFor } from '@/server/services/releases';

import { GET as GET_ONE } from './[slug]/route';
import { GET as GET_LIST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/releases', () => ({ listReleasesFor: vi.fn(), getReleaseFor: vi.fn() }));

const ctx = { organizationId: 'org-1', userId: 'user-1', role: 'staff' } as never;
const get = (path: string) => new Request(`https://stockpilotusa.com${path}`);
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx);
  vi.mocked(listReleasesFor).mockResolvedValue({
    releases: [],
    unreadCount: 0,
    latestUnread: null,
    stateAvailable: true,
  });
});

describe('GET /api/v1/me/releases', () => {
  it('returns the reader’s list, private and uncacheable', async () => {
    const res = await GET_LIST(get('/api/v1/me/releases'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(listReleasesFor).toHaveBeenCalledWith(ctx);
  });

  it('answers 401 with no session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await GET_LIST(get('/api/v1/me/releases'))).status).toBe(401);
    expect(listReleasesFor).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/me/releases/[slug]', () => {
  it('returns one release', async () => {
    vi.mocked(getReleaseFor).mockResolvedValue({ id: 'september-2026' } as never);
    const res = await GET_ONE(get('/api/v1/me/releases/september-2026'), params('september-2026'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ release: { id: 'september-2026' } });
  });

  it('404s alike for a release that does not exist and one that is not for this reader', async () => {
    vi.mocked(getReleaseFor).mockResolvedValue(null);
    expect((await GET_ONE(get('/x'), params('approvers-only'))).status).toBe(404);
  });

  it('404s a malformed slug without asking the service', async () => {
    for (const bad of ['../etc', 'UPPER', 'a_b', 'x'.repeat(81), '']) {
      expect((await GET_ONE(get('/x'), params(bad))).status, bad).toBe(404);
    }
    expect(getReleaseFor).not.toHaveBeenCalled();
  });

  it('answers 401 with no session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await GET_ONE(get('/x'), params('september-2026'))).status).toBe(401);
  });
});
