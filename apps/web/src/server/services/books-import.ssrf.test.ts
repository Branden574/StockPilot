import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Security wave E, MED-25 — the book-cover rehost is a server-side fetch of a
 * URL this process did not author: it arrives on the upstream book-lookup
 * response (`metadata.thumbnailUrl`). These tests pin the SSRF properties of
 * that fetch, not its implementation:
 *
 *   • a non-allowlisted host is never contacted at all;
 *   • a non-http(s) scheme is never contacted at all;
 *   • a redirect from an ALLOWLISTED host to a private/metadata target is
 *     not followed (this is the one that regressed: `covers.openlibrary.org`
 *     legitimately redirects, so the flow cannot simply refuse redirects);
 *   • an over-size body is refused;
 *   • and a legitimate cover still gets rehosted, so none of the above is
 *     achieved by breaking the feature.
 *
 * "Not contacted" / "not rehosted" is observed through the absence of the
 * `item_images.insert` that a successful rehost always performs.
 */

// Deterministic network. safeFetch dispatches through undici; every hop it
// takes shows up here, so `undiciFetch.mock.calls` IS the record of what this
// process actually connected to.
const undiciFetch = vi.fn();
vi.mock('undici', () => ({
  Agent: class {
    async close() {
      /* no-op */
    }
  },
  fetch: (...args: unknown[]) => undiciFetch(...args),
}));

// The cover hosts are real hostnames; resolve them to a public address so the
// guard's private-range check is the only thing that can reject them.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

const thumbnailUrlRef = { value: null as string | null };

vi.mock('@/lib/books/lookup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/books/lookup')>(
    '@/lib/books/lookup',
  );
  return {
    ...actual,
    lookupIsbn: vi.fn(async (isbn: string) => ({
      isbn,
      title: `Book ${isbn}`,
      authors: ['Author A'],
      publisher: null,
      publishedDate: null,
      description: null,
      pageCount: null,
      thumbnailUrl: thumbnailUrlRef.value,
      grade: null,
      source: 'google-books' as const,
    })),
  };
});

import { BooksImportService } from './books-import';

const ISBN = '9780140449136';
const WAREHOUSE_ID = 'wh-a';
const ITEM_ID = 'item-1';

/** A 1x1 PNG — small enough to pass the size cap, real enough to be a cover. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function okImage(bytes: Uint8Array = TINY_PNG, contentLength?: string) {
  const headers = new Map<string, string>([['content-type', 'image/png']]);
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: bodyStream(bytes),
  };
}

function redirectTo(location: string) {
  return {
    ok: false,
    status: 302,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'location' ? location : null),
    },
    body: null,
  };
}

function stub() {
  return makeSupabaseStub({
    'inventory_items.select': { data: [], error: null, count: 0 },
    'organizations.select': { data: { plan: 'pro' }, error: null },
    'inventory_items.insert': {
      data: [{ id: ITEM_ID, barcode: ISBN }],
      error: null,
    },
    'stock_movements.insert': { data: null, error: null },
    'item_images.insert': { data: null, error: null },
  });
}

/** Runs one import and reports whether a cover was actually rehosted. */
async function importOne(thumbnailUrl: string): Promise<{
  rehosted: boolean;
  hops: string[];
}> {
  thumbnailUrlRef.value = thumbnailUrl;
  const s = stub();
  const svc = new BooksImportService(makeServiceContext(s.client));
  const result = await svc.execute([ISBN], {
    warehouseId: WAREHOUSE_ID,
    defaultQuantity: 0,
  });
  // The book itself must always import — a refused cover is non-fatal.
  expect(result.created).toBe(1);
  return {
    rehosted: (s.chainArgs.get('item_images.insert') ?? []).length > 0,
    hops: undiciFetch.mock.calls.map((c) => String(c[0])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  undiciFetch.mockReset();
  thumbnailUrlRef.value = null;
});

describe('cover rehost — SSRF properties', () => {
  it('never connects to a host outside the cover allowlist', async () => {
    const { rehosted, hops } = await importOne('https://evil.example.com/cover.jpg');
    expect(hops).toEqual([]);
    expect(rehosted).toBe(false);
  });

  it('never connects to a private / metadata address given directly', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/cover.jpg',
      'http://127.0.0.1/cover.jpg',
      'http://10.0.0.5/cover.jpg',
      'http://[::1]/cover.jpg',
      'http://[::ffff:169.254.169.254]/cover.jpg',
    ]) {
      undiciFetch.mockReset();
      const { rehosted, hops } = await importOne(url);
      expect(hops, url).toEqual([]);
      expect(rehosted, url).toBe(false);
    }
  });

  it('refuses a non-http(s) scheme', async () => {
    const { rehosted, hops } = await importOne('file:///etc/passwd');
    expect(hops).toEqual([]);
    expect(rehosted).toBe(false);
  });

  it('does NOT follow an allowlisted host that redirects to the metadata IP', async () => {
    undiciFetch.mockResolvedValueOnce(
      redirectTo('http://169.254.169.254/latest/meta-data/iam/'),
    );
    const { rehosted, hops } = await importOne(
      'https://covers.openlibrary.org/b/isbn/9780140449136-L.jpg',
    );
    // The first hop is legitimate; the metadata target must never be reached.
    expect(hops).toHaveLength(1);
    expect(hops.join(' ')).not.toContain('169.254.169.254');
    expect(rehosted).toBe(false);
  });

  it('does NOT follow an allowlisted host that redirects off the allowlist', async () => {
    undiciFetch.mockResolvedValueOnce(redirectTo('https://evil.example.com/x.jpg'));
    const { rehosted, hops } = await importOne(
      'https://covers.openlibrary.org/b/isbn/9780140449136-L.jpg',
    );
    expect(hops).toHaveLength(1);
    expect(hops.join(' ')).not.toContain('evil.example.com');
    expect(rehosted).toBe(false);
  });

  it('refuses a body that exceeds the size cap even when content-length lies', async () => {
    // Advertises 10 bytes, streams 6MB. The streaming cap is what must stop it.
    undiciFetch.mockResolvedValueOnce(
      okImage(new Uint8Array(6 * 1024 * 1024), '10'),
    );
    const { rehosted } = await importOne(
      'https://covers.openlibrary.org/b/isbn/9780140449136-L.jpg',
    );
    expect(rehosted).toBe(false);
  });
});

describe('cover rehost — the legitimate flow still works', () => {
  it('rehosts a cover served directly by an allowlisted host', async () => {
    undiciFetch.mockResolvedValueOnce(okImage());
    const { rehosted, hops } = await importOne(
      'https://books.google.com/books/content?id=abc&printsec=frontcover',
    );
    expect(hops).toHaveLength(1);
    expect(rehosted).toBe(true);
  });

  it('follows the Open Library -> archive.org redirect that real covers use', async () => {
    undiciFetch
      .mockResolvedValueOnce(
        redirectTo('https://ia801600.us.archive.org/view_archive.php?cover.jpg'),
      )
      .mockResolvedValueOnce(okImage());
    const { rehosted, hops } = await importOne(
      'https://covers.openlibrary.org/b/isbn/9780140449136-L.jpg',
    );
    expect(hops).toHaveLength(2);
    expect(rehosted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): the cover's type comes from its
// BYTES, through the one upload check. The remote server's content-type no
// longer picks the extension or the stored type; a cover that is not a
// picture, or hides a file after the picture, is not stored, the book still
// imports, and exactly one malware / blocked event is recorded in the
// organization, with no link and no path.
// ---------------------------------------------------------------------------
describe('cover rehost — the upload check', () => {
  const COVER_URL = 'https://books.google.com/books/content?id=abc&printsec=frontcover';
  /** A JPEG: start, one frame header, end (made up; no pixels). */
  const TINY_JPEG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00, 0xff, 0xd9,
  ]);

  async function importWithStorage(body: Uint8Array) {
    undiciFetch.mockResolvedValueOnce(okImage(body));
    thumbnailUrlRef.value = COVER_URL;
    const s = stub();
    const upload = vi.fn(async () => ({ data: { path: 'p' }, error: null }));
    s.client.storage.from = vi.fn(() => ({ upload, remove: vi.fn() })) as never;
    const svc = new BooksImportService(makeServiceContext(s.client, { organizationId: 'org-test' }));
    const result = await svc.execute([ISBN], { warehouseId: WAREHOUSE_ID, defaultQuantity: 0 });
    expect(result.created).toBe(1);
    return { upload, rows: s.chainArgs.get('item_images.insert') ?? [] };
  }

  const record = async () => vi.mocked((await import('@/server/security/events')).recordSecurityEvent);

  it('a JPEG served as image/png is stored as a JPEG, byte for byte, and nothing is recorded', async () => {
    const { upload, rows } = await importWithStorage(TINY_JPEG);
    expect(rows.length).toBe(1);
    const [path, bytes, opts] = upload.mock.calls[0]! as unknown as [string, Uint8Array, { contentType: string }];
    expect(path).toMatch(/\/cover\.jpg$/);
    expect(opts.contentType).toBe('image/jpeg');
    expect(Array.from(bytes)).toEqual(Array.from(TINY_JPEG));
    expect(await record()).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page served as a picture', new TextEncoder().encode('<!DOCTYPE html><p>no</p>'), 'upload_wrong_type'],
    ['an archive after the picture', new Uint8Array([...TINY_JPEG, 0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), 'upload_hidden_file'],
  ])('%s: not stored, no row, the book still imports, one event', async (_what, body, reason) => {
    const { upload, rows } = await importWithStorage(body);
    expect(upload).not.toHaveBeenCalled();
    expect(rows.length).toBe(0);
    const rec = await record();
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec.mock.calls[0]![0]).toEqual({
      category: 'malware',
      outcome: 'blocked',
      reason,
      source: 'web',
      organizationId: 'org-test',
    });
    expect(JSON.stringify(rec.mock.calls[0])).not.toContain('books.google.com');
  });

  it('a recorder that fails: the cover is still not stored', async () => {
    (await record()).mockRejectedValueOnce(new Error('recorder down'));
    const { upload, rows } = await importWithStorage(new TextEncoder().encode('<html></html>'));
    expect(upload).not.toHaveBeenCalled();
    expect(rows.length).toBe(0);
  });
});
