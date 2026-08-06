import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /m/[token]/photo/[n] is the fix for C1: the ONLY way a photo byte
 * ever reaches the public share page now (see /m/[token]/page.tsx, which
 * renders exclusively `/m/<token>/photo/<n>` URLs). This suite pins: the
 * SAME resolver funnel is used (`resolveMaintenanceSharePhoto`, which
 * shares its token-validity core with the page's own
 * `resolveMaintenanceShareToken` — see maintenance-share-links.test.ts),
 * Content-Type comes from the STORED sniffed mime type (never a client
 * input), the response never caches, and every miss — malformed token,
 * malformed/out-of-range `n`, rate-limited, unresolved token, or a failed
 * Storage download — 404s the same generic way.
 */

const clientIpFromRequestMock = vi.fn((_req: unknown) => 'unknown');
vi.mock('@/lib/client-ip', () => ({
  clientIpFromRequest: (req: unknown) => clientIpFromRequestMock(req),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

const resolveMaintenanceSharePhotoMock = vi.fn();
const hashShareTokenMock = vi.fn((token: string) => `sha256:${token}`);
vi.mock('@/server/services/maintenance-share-links', () => ({
  resolveMaintenanceSharePhoto: (...args: unknown[]) => resolveMaintenanceSharePhotoMock(...args),
  hashShareToken: (token: string) => hashShareTokenMock(token),
}));

const downloadMock = vi.fn();
const storageFromMock = vi.fn(() => ({ download: downloadMock }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: storageFromMock } }),
}));

import { GET } from './route';

const TOKEN = 'e'.repeat(64);

function blobFor(bytes: Uint8Array) {
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function makeRequest(): Parameters<typeof GET>[0] {
  return new Request('https://test.local/m/token/photo/0') as unknown as Parameters<typeof GET>[0];
}

function callRoute(token: string, n: string) {
  return GET(makeRequest(), { params: Promise.resolve({ token, n }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  clientIpFromRequestMock.mockReturnValue('unknown');
  checkRateLimitMock.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
  hashShareTokenMock.mockImplementation((token: string) => `sha256:${token}`);
  resolveMaintenanceSharePhotoMock.mockResolvedValue(null);
  downloadMock.mockResolvedValue({ data: null, error: { message: 'not stubbed for this test' } });
});

describe('GET /m/[token]/photo/[n]', () => {
  it('streams the object bytes with the STORED mime type, an inline Content-Disposition, and Cache-Control: private, no-store', async () => {
    resolveMaintenanceSharePhotoMock.mockResolvedValue({
      storagePath: 'org/req/att-1.jpg',
      mimeType: 'image/jpeg',
      filename: 'break-room.jpg',
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });

    const res = await callRoute(TOKEN, '0');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="break-room-jpg.jpg"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4]);
    expect(downloadMock).toHaveBeenCalledWith('org/req/att-1.jpg');
    expect(storageFromMock).toHaveBeenCalledWith('maintenance-photos');
  });

  it('derives the Content-Disposition extension from the STORED mime type, never trusting anything client-supplied — a .webp thumbnail gets .webp even if the filename lost its extension at upload time', async () => {
    resolveMaintenanceSharePhotoMock.mockResolvedValue({
      storagePath: 'org/req/att-2.webp',
      mimeType: 'image/webp',
      filename: 'hallway',
    });
    downloadMock.mockResolvedValue({ data: blobFor(new Uint8Array([9])), error: null });

    const res = await callRoute(TOKEN, '1');

    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="hallway.webp"');
  });

  it('404s (generic) for a too-short or oversized token, BEFORE spending any rate-limit budget or resolving', async () => {
    await expect((await callRoute('short', '0')).status).toBe(404);
    await expect((await callRoute('a'.repeat(200), '0')).status).toBe(404);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(resolveMaintenanceSharePhotoMock).not.toHaveBeenCalled();
  });

  it('404s for a malformed `n` (non-numeric, negative, decimal) — bounded strictly to a bare non-negative integer', async () => {
    for (const bad of ['-1', '1.5', 'abc', '', '0x1', '1e3']) {
      const res = await callRoute(TOKEN, bad);
      expect(res.status).toBe(404);
    }
    expect(resolveMaintenanceSharePhotoMock).not.toHaveBeenCalled();
  });

  it('404s when the photo does not resolve (unknown/revoked/expired token, or an out-of-range index) — resolveMaintenanceSharePhoto owns that bounds check', async () => {
    resolveMaintenanceSharePhotoMock.mockResolvedValue(null);
    const res = await callRoute(TOKEN, '99');
    expect(res.status).toBe(404);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('404s when the Storage download fails — never a 500, never a partial/broken body', async () => {
    resolveMaintenanceSharePhotoMock.mockResolvedValue({
      storagePath: 'org/req/att-1.jpg',
      mimeType: 'image/jpeg',
      filename: 'break-room.jpg',
    });
    downloadMock.mockResolvedValue({ data: null, error: { message: 'object not found' } });
    const res = await callRoute(TOKEN, '0');
    expect(res.status).toBe(404);
  });

  it('rate-limits the SAME per-token bucket the page uses — hashed via hashShareToken, never a raw/sliced token (fix wave m6)', async () => {
    await callRoute(TOKEN, '0');
    expect(hashShareTokenMock).toHaveBeenCalledWith(TOKEN);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      `maintenance:share:token:sha256:${TOKEN}`,
      120,
      3600000,
      'closed',
    );
  });

  it('also rate-limits per IP via the repo\'s hardened clientIpFromRequest helper (fix wave I4) when the IP is known', async () => {
    clientIpFromRequestMock.mockReturnValue('203.0.113.9');
    await callRoute(TOKEN, '0');
    expect(checkRateLimitMock).toHaveBeenCalledWith('maintenance:share:ip:203.0.113.9', 60, 3600000, 'closed');
  });

  it('MUTATION GUARD (I4) — skips the IP bucket when unresolved ("unknown") rather than collapsing every such caller onto one global bucket', async () => {
    clientIpFromRequestMock.mockReturnValue('unknown');
    await callRoute(TOKEN, '0');
    const ipCalls = checkRateLimitMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('maintenance:share:ip:'),
    );
    expect(ipCalls).toHaveLength(0);
  });

  it('MUTATION GUARD — a rate-limited token bucket 404s and never calls the resolver or Storage', async () => {
    checkRateLimitMock.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('maintenance:share:token:'),
      count: 999,
      resetAt: Date.now(),
    }));
    const res = await callRoute(TOKEN, '0');
    expect(res.status).toBe(404);
    expect(resolveMaintenanceSharePhotoMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — a rate-limited IP bucket 404s the same way when the IP is known', async () => {
    clientIpFromRequestMock.mockReturnValue('203.0.113.9');
    checkRateLimitMock.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('maintenance:share:ip:'),
      count: 999,
      resetAt: Date.now(),
    }));
    const res = await callRoute(TOKEN, '0');
    expect(res.status).toBe(404);
    expect(resolveMaintenanceSharePhotoMock).not.toHaveBeenCalled();
  });
});
