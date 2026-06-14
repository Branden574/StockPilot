import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Public endpoint is now per-IP rate-limited (fail-closed). Mock it allow-by-
// default so the lookup-behavior tests run; one test flips it to denied.
const checkRateLimitMock = vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...(a as [])),
}));
vi.mock('@/lib/client-ip', () => ({ clientIpFromRequest: () => '203.0.113.7' }));

import { GET } from './route';

type FetchMock = ReturnType<typeof vi.fn>;

const ORIGINAL_FETCH = global.fetch;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse() {
  return jsonResponse({});
}

/**
 * Routes the four upstream APIs to specific stub bodies based on the URL.
 * Order in `route.ts`: googleBooks, openLibrary (api/books), openLibrarySearch
 * (search.json), libraryOfCongress (loc.gov).
 */
function setupFetch(opts: {
  google?: unknown | null;
  openLibrary?: unknown | null;
  openLibrarySearch?: unknown | null;
  loc?: unknown | null;
  failAll?: boolean;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (opts.failAll) return jsonResponse({}, { ok: false, status: 500 });
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    if (url.includes('googleapis.com/books')) {
      return opts.google === null
        ? jsonResponse({}, { ok: false, status: 404 })
        : jsonResponse(opts.google ?? {});
    }
    if (url.includes('openlibrary.org/api/books')) {
      return opts.openLibrary === null
        ? jsonResponse({}, { ok: false, status: 404 })
        : jsonResponse(opts.openLibrary ?? {});
    }
    if (url.includes('openlibrary.org/search.json')) {
      return opts.openLibrarySearch === null
        ? jsonResponse({}, { ok: false, status: 404 })
        : jsonResponse(opts.openLibrarySearch ?? {});
    }
    if (url.includes('loc.gov/search')) {
      return opts.loc === null
        ? jsonResponse({}, { ok: false, status: 404 })
        : jsonResponse(opts.loc ?? {});
    }
    return emptyResponse();
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock as unknown as FetchMock;
}

describe('GET /api/books/lookup', () => {
  beforeEach(() => {
    // Default: nothing matches at all sources.
    setupFetch({ google: null, openLibrary: null, openLibrarySearch: null, loc: null });
    checkRateLimitMock.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('returns 429 when the per-IP rate limit is exceeded (no upstream fetch)', async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, count: 31, resetAt: Date.now() + 1000 });
    const fetchSpy = setupFetch({ google: { totalItems: 1 } });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780306406157'));
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled(); // limited BEFORE any outbound call
  });

  it('returns 400 for invalid ISBN like "abc"', async () => {
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=abc'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid ISBN format' });
  });

  it('returns 400 when isbn param is missing', async () => {
    const res = await GET(new Request('https://test.local/api/books/lookup'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing isbn param' });
  });

  it('accepts ISBN-13 with dashes (normalizes by stripping non-digits)', async () => {
    setupFetch({
      google: { items: [{ volumeInfo: { title: 'Hello' } }] },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=978-0-13-110362-7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isbn).toBe('9780131103627');
    expect(body.title).toBe('Hello');
  });

  it('accepts ISBN-10 with trailing X', async () => {
    setupFetch({
      google: { items: [{ volumeInfo: { title: 'Old Book' } }] },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=0-306-40615-x'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isbn).toBe('030640615X');
  });

  it('returns 404 when no source has data', async () => {
    setupFetch({ google: null, openLibrary: null, openLibrarySearch: null, loc: null });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780131103627'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No metadata found for this ISBN' });
  });

  it('detects "Grade 12" from a Google Books title via merged grade', async () => {
    setupFetch({
      google: {
        items: [
          {
            volumeInfo: {
              title: 'Into Literature Grade 12',
              authors: ['HMH'],
              categories: [],
            },
          },
        ],
      },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780131103627'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grade).toBe('12');
  });

  it('detects "12th grade" form and "g4" form via different sources', async () => {
    // Open Library reports the title that triggers "12th grade" detection
    // because Google Books returned no data.
    setupFetch({
      google: null,
      openLibrary: {
        'ISBN:9780131103627': {
          title: 'Big Ideas Math: 12th grade Algebra II',
          authors: [{ name: 'Larson' }],
        },
      },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780131103627'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grade).toBe('12');
    expect(body.title).toBe('Big Ideas Math: 12th grade Algebra II');
  });

  it('detects kindergarten as "K"', async () => {
    setupFetch({
      google: {
        items: [{ volumeInfo: { title: 'Wonders Kindergarten Student Book' } }],
      },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780131103627'));
    expect(res.status).toBe(200);
    expect((await res.json()).grade).toBe('K');
  });

  it('merges fields by taking first non-null per field across sources', async () => {
    // Google Books gives a title but no description; Open Library fills in
    // description; LoC fills in publisher.
    setupFetch({
      google: {
        items: [
          {
            volumeInfo: {
              title: 'Awesome Book',
              authors: ['Jane Doe'],
              // no description, no pageCount
            },
          },
        ],
      },
      openLibrary: {
        'ISBN:9780131103627': {
          title: 'Awesome Book (alt)',
          authors: [{ name: 'Jane D.' }],
          notes: 'A long description from open library.',
          number_of_pages: 240,
        },
      },
      openLibrarySearch: null,
      loc: {
        results: [
          {
            title: 'Awesome Book (LoC edition)',
            contributor: ['Doe, Jane, 1970-'],
            partof_division: ['Random House'],
            date: '2020',
          },
        ],
      },
    });
    const res = await GET(new Request('https://test.local/api/books/lookup?isbn=9780131103627'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Awesome Book');
    expect(body.authors).toEqual(['Jane Doe']);
    // description came from Open Library (Google's was null).
    expect(body.description).toBe('A long description from open library.');
    expect(body.pageCount).toBe(240);
    // publisher came from LoC (others were null).
    expect(body.publisher).toBe('Random House');
    // sources should list every source that successfully returned data.
    expect(body.sources).toEqual(
      expect.arrayContaining(['google-books', 'open-library', 'library-of-congress']),
    );
  });
});
