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

// The resolver, so no test here touches the network. Its default answers the
// way a real resolver answers a name it cannot resolve. That includes a
// bracketed IPv6 literal: url.hostname keeps the brackets ('[::1]'), which the
// literal checks do not recognise, so the two IPv6 cases above are refused when
// the lookup of '[::1]' fails, as they were against the real resolver.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  assertSafeFetchUrl,
  safeFetch,
  SsrfBlockedError,
  SsrfLookupFailedError,
} from './ssrf-guard';

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
  lookupMock.mockReset();
  lookupMock.mockRejectedValue(
    Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
  );
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

/** What a promise has done by the time `ms` of real time has passed. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (e: unknown) => e,
    ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

describe('safeFetch — a failed lookup is not a refusal', () => {
  const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

  it('rejects a failed lookup with SsrfLookupFailedError, which is still an SsrfBlockedError', async () => {
    lookupMock.mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo EAI_AGAIN covers.example.test'), { code: 'EAI_AGAIN' }),
    );
    const err = await safeFetch('https://covers.example.test/a.jpg').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfLookupFailedError);
    // Callers that only know the parent class still treat it as blocked.
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats an answer with no address as a failed lookup', async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(safeFetch('https://covers.example.test/a.jpg')).rejects.toBeInstanceOf(
      SsrfLookupFailedError,
    );
  });

  it('refuses a host that resolves to a private address, and that is not a failed lookup', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const err = await safeFetch('https://covers.example.test/a.jpg').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(err).not.toBeInstanceOf(SsrfLookupFailedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a host off the allowlist before any lookup, and that is not a failed lookup', async () => {
    const err = await safeFetch('https://elsewhere.example.test/a.jpg', {
      hostAllowlist: ['covers.example.test'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(err).not.toBeInstanceOf(SsrfLookupFailedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('connects to the address the lookup returned', async () => {
    lookupMock.mockResolvedValueOnce(PUBLIC);
    mockFetch.mockResolvedValueOnce(resp(200));
    const r = await safeFetch('https://covers.example.test/a.jpg');
    expect(r.status).toBe(200);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * node's lookup takes no signal, so a resolver that is slow to answer used to
 * hold safeFetch past the caller's own timeout: the abort was only seen once
 * the lookup settled, and again on every redirect hop.
 */
describe("safeFetch — the caller's abort ends a lookup that has not answered", () => {
  it('rejects with the abort as soon as the signal aborts', async () => {
    lookupMock.mockReturnValue(new Promise(() => {})); // a resolver that never answers
    const controller = new AbortController();
    const pending = safeFetch('https://covers.example.test/a.jpg', { signal: controller.signal });
    controller.abort();
    const outcome = await settledWithin(pending, 200);
    expect(outcome).toBeInstanceOf(DOMException);
    expect((outcome as DOMException).name).toBe('AbortError');
    // An abort is the caller's timeout, never a refusal or a failed lookup.
    expect(outcome).not.toBeInstanceOf(SsrfBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects with the reason the caller aborted with (a timeout signal)', async () => {
    lookupMock.mockReturnValue(new Promise(() => {}));
    const outcome = await settledWithin(
      safeFetch('https://covers.example.test/a.jpg', { signal: AbortSignal.timeout(20) }),
      500,
    );
    expect(outcome).toBeInstanceOf(DOMException);
    expect((outcome as DOMException).name).toBe('TimeoutError');
  });

  it('starts no lookup for a signal that has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await settledWithin(
      safeFetch('https://covers.example.test/a.jpg', { signal: controller.signal }),
      200,
    );
    expect((outcome as DOMException).name).toBe('AbortError');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('ends the lookup of a redirect hop too', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockReturnValueOnce(new Promise(() => {}));
    mockFetch.mockResolvedValueOnce(resp(302, 'https://archive.example.test/b.jpg'));
    const controller = new AbortController();
    const pending = safeFetch('https://covers.example.test/a.jpg', { signal: controller.signal });
    await vi.waitFor(() => expect(lookupMock).toHaveBeenCalledTimes(2));
    controller.abort();
    const outcome = await settledWithin(pending, 200);
    expect((outcome as DOMException).name).toBe('AbortError');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still answers a lookup that finishes before the abort', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce(resp(200));
    const controller = new AbortController();
    const r = await safeFetch('https://covers.example.test/a.jpg', { signal: controller.signal });
    expect(r.status).toBe(200);
    // The pinned request still carries the caller's signal.
    expect(mockFetch.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
