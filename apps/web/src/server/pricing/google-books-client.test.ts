import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Google not answering (a rate limit, an error reply, no reply) is told
 * apart from a real "no price found" answer, so the price pull never records
 * it as one.
 */

vi.mock('@/lib/env', () => ({ env: {} }));

import { googleBooksClient, GoogleBooksUnavailableError } from './google-books-client';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('googleBooksClient.fetchVolumeByIsbn', () => {
  it('a rate limit (429) throws GoogleBooksUnavailableError with the status', async () => {
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));
    const err: unknown = await googleBooksClient
      .fetchVolumeByIsbn('978-0-306-40615-7')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleBooksUnavailableError);
    expect((err as GoogleBooksUnavailableError).status).toBe(429);
  });

  it('an error reply throws it too', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 503 }));
    await expect(googleBooksClient.fetchVolumeByIsbn('9780306406157')).rejects.toMatchObject({
      name: 'GoogleBooksUnavailableError',
      status: 503,
    });
  });

  it('no reply at all throws it, with no status', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(googleBooksClient.fetchVolumeByIsbn('9780306406157')).rejects.toMatchObject({
      name: 'GoogleBooksUnavailableError',
      status: null,
    });
  });

  it('a 200 whose body is not JSON throws it too: Google did not really answer', async () => {
    fetchMock.mockResolvedValue(new Response('<html>busy</html>', { status: 200 }));
    await expect(googleBooksClient.fetchVolumeByIsbn('9780306406157')).rejects.toMatchObject({
      name: 'GoogleBooksUnavailableError',
      status: 200,
    });
  });

  it('an answer with no volume is returned as it is: a real "no price found"', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ kind: 'books#volumes', totalItems: 0 }), { status: 200 }),
    );
    await expect(googleBooksClient.fetchVolumeByIsbn('9780306406157')).resolves.toEqual({
      kind: 'books#volumes',
      totalItems: 0,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('q=isbn%3A9780306406157');
  });
});
