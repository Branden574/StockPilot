import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/v1/cycle-counts/[id]/exceptions (F1-2): the count screen's linked
 * exceptions, cookie or Bearer. A failed read is a 500, never an empty list.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
const listForCount = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: vi.fn(function (this: { listForCount: typeof listForCount }) {
    this.listForCount = listForCount;
  }),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';

import { GET } from './route';

const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (headers: Record<string, string> = { authorization: 'Bearer t' }) =>
  new Request(`https://t.local/api/v1/cycle-counts/${CC}/exceptions`, { headers }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue({ organizationId: 'org-1', userId: 'u-1', role: 'staff' } as never);
});

describe('GET /api/v1/cycle-counts/[id]/exceptions', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await GET(get(), params(CC))).status).toBe(401);
  });

  it('400 for an id that is not a uuid, without reading', async () => {
    expect((await GET(get(), params('nope'))).status).toBe(400);
    expect(listForCount).not.toHaveBeenCalled();
  });

  it('answers a Bearer and a cookie caller with the service result, never cached', async () => {
    listForCount.mockResolvedValue({ cycleCountId: CC, exceptions: [], unrecognized: 0 });
    for (const headers of [{ authorization: 'Bearer t' }, { cookie: 'sb-x-auth-token=abc' }] as Array<Record<string, string>>) {
      const r = get(headers);
      const res = await GET(r, params(CC));
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await res.json()).toMatchObject({ organizationId: 'org-1', cycleCountId: CC });
      expect(vi.mocked(withApiContext)).toHaveBeenLastCalledWith(r);
    }
    expect(listForCount).toHaveBeenCalledWith(CC);
  });

  it('404 when the count is not visible; 500 (never an empty list) when a read fails', async () => {
    listForCount.mockRejectedValueOnce(new ServiceError('not_found', 'Cycle count not found.'));
    expect((await GET(get(), params(CC))).status).toBe(404);
    listForCount.mockRejectedValueOnce(new ServiceError('internal_error', 'stall'));
    const res = await GET(get(), params(CC));
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('exceptions');
  });
});
