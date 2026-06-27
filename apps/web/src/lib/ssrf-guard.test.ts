import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock undici so safeFetch's network hops are deterministic. The SSRF guard's
// security depends on resolveSafeUrl being re-run on every redirect hop; these
// tests drive redirects to private/metadata targets and assert they're blocked.
const mockFetch = vi.fn();
vi.mock('undici', () => ({
  Agent: class {
    async close() {
      /* no-op */
    }
  },
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

import { assertSafeFetchUrl, safeFetch, SsrfBlockedError } from './ssrf-guard';

function resp(status: number, location?: string) {
  return {
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null),
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('assertSafeFetchUrl — IP-literal classification (no network)', () => {
  it('blocks the AWS/GCP metadata IP', async () => {
    await expect(
      assertSafeFetchUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks private + loopback literals', async () => {
    for (const u of ['http://10.0.0.1/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/']) {
      await expect(assertSafeFetchUrl(u)).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it('blocks IPv4-mapped IPv6 pointing at metadata', async () => {
    await expect(
      assertSafeFetchUrl('http://[::ffff:169.254.169.254]/'),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks non-http(s) schemes', async () => {
    await expect(assertSafeFetchUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a public IP literal', async () => {
    await expect(assertSafeFetchUrl('http://93.184.216.34/')).resolves.toBeInstanceOf(URL);
  });

  it('enforces hostAllowlist', async () => {
    await expect(
      assertSafeFetchUrl('http://93.184.216.34/', { hostAllowlist: ['1.2.3.4'] }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('safeFetch — redirects are re-validated through the guard', () => {
  it('blocks a redirect whose Location is the metadata IP', async () => {
    mockFetch.mockResolvedValueOnce(resp(302, 'http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('http://93.184.216.34/start')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks a redirect whose Location is a private IP literal', async () => {
    mockFetch.mockResolvedValueOnce(resp(302, 'http://10.0.0.5/internal'));
    await expect(safeFetch('http://93.184.216.34/start')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('passes a normal 200 response through', async () => {
    mockFetch.mockResolvedValueOnce(resp(200));
    const r = await safeFetch('http://93.184.216.34/ok');
    expect(r.status).toBe(200);
  });

  it('throws after exceeding the redirect cap', async () => {
    mockFetch.mockResolvedValue(resp(302, 'http://93.184.216.34/loop'));
    await expect(safeFetch('http://93.184.216.34/start')).rejects.toThrow(/too many redirects/i);
  });

  it('does not follow (or re-block) when the caller opts out with redirect:manual', async () => {
    mockFetch.mockResolvedValueOnce(resp(302, 'http://169.254.169.254/'));
    const r = await safeFetch('http://93.184.216.34/start', { redirect: 'manual' });
    expect(r.status).toBe(302);
  });
});
