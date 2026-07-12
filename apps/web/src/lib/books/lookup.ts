/**
 * ISBN → metadata pipeline. Hits Google Books, Open Library (books +
 * search), and the Library of Congress in parallel and merges the
 * fields field-by-field so a missing description from one source can
 * be filled in from another.
 *
 * Extracted from the /api/books/lookup route so both the public lookup
 * endpoint and the server-side AI tools share the exact same pipeline
 * (no logic drift, one place to fix).
 *
 * All sources are keyless free public APIs. Each fetch has its own
 * AbortSignal.timeout() so a single slow source can't pin the whole
 * lookup — a 7s LoC slowpoke caps the whole thing.
 *
 * A persistent cache (book_metadata_cache, migration 0262) fronts the whole
 * pipeline: a resolved ISBN is served from the DB on later scans, so repeat
 * scans and bulk-import duplicates cost zero external-API quota (the Google
 * Books daily quota was the bottleneck). Records that resolved WITHOUT Google
 * Books (the source that intermittently 429s) are marked provisional and
 * re-verified after a window so a thin record captured during an outage is
 * upgraded once the quota recovers, rather than frozen forever.
 */

import { isbnVariants } from './isbn-variants';

export type LookupSource =
  | 'google-books'
  | 'open-library'
  | 'open-library-search'
  | 'library-of-congress'
  | 'gemini';

export interface BookMetadata {
  isbn: string;
  title: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  pageCount: number | null;
  thumbnailUrl: string | null;
  /** Detected K-12 / college grade level when title or subjects mention one. */
  grade: string | null;
  source: LookupSource;
  /** Every source that successfully returned data; useful for debugging. */
  sources?: LookupSource[];
}

export function normalizeIsbn(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
  return null;
}

/**
 * Canonical cache key for an ISBN: the ISBN-13 form when derivable (so the
 * same physical book scanned as its ISBN-10 or ISBN-13 barcode shares one
 * cache row), else the input unchanged (979-prefixed 13s have no ISBN-10;
 * unparseable values fall back to themselves).
 */
function canonicalIsbnKey(normalized: string): string {
  const variants = isbnVariants(normalized);
  return variants.find((v) => v.length === 13) ?? normalized;
}

/**
 * Persistent cache read (books "database", migration 0262). Best-effort:
 * ANY failure (DB down, row shape drift) returns null so the caller falls
 * through to a live lookup — the cache must never break a scan. Keyed by the
 * canonical ISBN-13.
 */
/**
 * A cached record is "authoritative" (serve forever) when Google Books — the
 * richest source and the one that intermittently 429s — contributed to it.
 * A record WITHOUT google-books is "provisional": it was likely captured
 * while the quota was exhausted (Open Library / LoC only → correct title but
 * thinner description/cover), so we re-verify it after this window instead of
 * freezing degraded metadata. On re-verify the live lookup re-caches: it
 * upgrades to authoritative once the quota recovers, or resets the window if
 * Google Books is still down (bounded to one retry per window, self-healing).
 */
const PROVISIONAL_RECHECK_MS = 6 * 60 * 60 * 1000; // 6 hours

async function readBookCache(key: string): Promise<BookMetadata | null> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    const { data } = await admin
      .from('book_metadata_cache')
      .select(
        'isbn, title, authors, publisher, published_date, description, page_count, thumbnail_url, grade, source, sources, fetched_at',
      )
      .eq('isbn', key)
      .maybeSingle();
    if (!data) return null;
    const r = data as {
      isbn: string;
      title: string | null;
      authors: unknown;
      publisher: string | null;
      published_date: string | null;
      description: string | null;
      page_count: number | null;
      thumbnail_url: string | null;
      grade: string | null;
      source: string | null;
      sources: unknown;
      fetched_at: string;
    };
    // Provisional (no google-books) + past the recheck window → miss, so the
    // caller runs a fresh lookup and re-caches (see PROVISIONAL_RECHECK_MS).
    const hasRichSource = Array.isArray(r.sources) && r.sources.includes('google-books');
    if (!hasRichSource) {
      const ageMs = Date.now() - new Date(r.fetched_at).getTime();
      if (Number.isFinite(ageMs) && ageMs > PROVISIONAL_RECHECK_MS) return null;
    }
    return {
      isbn: r.isbn,
      title: r.title,
      authors: Array.isArray(r.authors) ? (r.authors as string[]) : [],
      publisher: r.publisher,
      publishedDate: r.published_date,
      description: r.description,
      pageCount: r.page_count,
      thumbnailUrl: r.thumbnail_url,
      grade: r.grade,
      source: (r.source as LookupSource | null) ?? 'open-library',
      sources: Array.isArray(r.sources) ? (r.sources as LookupSource[]) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Persistent cache write (best-effort — a write failure never surfaces to
 * the caller). Only real-bibliographic-source results reach here (the caller
 * excludes AI-fallback-only and untitled results). Upserts on the canonical
 * ISBN-13: a provisional row (no google-books) re-verified after the recheck
 * window is overwritten here — upgraded to authoritative when the quota has
 * recovered, or re-stamped (window reset) if Google Books is still down.
 */
async function writeBookCache(key: string, meta: BookMetadata): Promise<void> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    await admin.from('book_metadata_cache').upsert(
      {
        isbn: key,
        title: meta.title,
        authors: meta.authors,
        publisher: meta.publisher,
        published_date: meta.publishedDate,
        description: meta.description,
        page_count: meta.pageCount,
        thumbnail_url: meta.thumbnailUrl,
        grade: meta.grade,
        source: meta.source,
        sources: meta.sources ?? [meta.source],
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'isbn' },
    );
  } catch {
    // best-effort: caching is an optimization, never a correctness requirement
  }
}

function detectGrade(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const s = blob.toLowerCase();
  let m = s.match(/grade\s+(k|kindergarten|\d{1,2})/);
  if (!m) m = s.match(/(\d{1,2})(?:st|nd|rd|th)\s+grade/);
  if (!m) m = s.match(/\bg(\d{1,2})\b/);
  if (m) {
    const raw = m[1]!;
    if (raw === 'k' || raw === 'kindergarten') return 'K';
    const n = Number(raw);
    if (n >= 1 && n <= 12) return String(n);
  }
  if (/\b(college|university|undergraduate|higher\s*ed)\b/.test(s)) return 'College';
  if (/\bkindergarten\b/.test(s)) return 'K';
  return null;
}

async function fetchGoogleBooks(isbn: string): Promise<BookMetadata | null> {
  const params = new URLSearchParams({ q: `isbn:${isbn}` });
  // Keyless works at LOW volume, but the keyless quota is shared per egress
  // IP — on Vercel's shared IPs it is routinely exhausted by other tenants,
  // which used to make our best source silently return 429 all day (and the
  // pipeline then treated "quota exceeded" as "book doesn't exist", pushing
  // every scan to the AI fallback). Set GOOGLE_BOOKS_API_KEY to get a quota
  // attributed to OUR project instead.
  const { env } = await import('@/lib/env');
  if (env.GOOGLE_BOOKS_API_KEY) params.set('key', env.GOOGLE_BOOKS_API_KEY);
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 429) {
    // Make quota exhaustion VISIBLE in logs — silently mapping it to
    // "no data" is how the wrong-book hallucination hid for so long.
    console.warn(
      '[books] Google Books 429 (quota exhausted) — set GOOGLE_BOOKS_API_KEY to restore the primary lookup source',
    );
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as {
    items?: Array<{
      volumeInfo?: {
        title?: string;
        authors?: string[];
        publisher?: string;
        publishedDate?: string;
        description?: string;
        pageCount?: number;
        imageLinks?: { thumbnail?: string; smallThumbnail?: string };
        categories?: string[];
      };
    }>;
  };
  const v = data.items?.[0]?.volumeInfo;
  if (!v) return null;
  const thumb = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? null;
  const blob = [v.title ?? '', ...(v.categories ?? [])].join(' ');
  return {
    isbn,
    title: v.title ?? null,
    authors: v.authors ?? [],
    publisher: v.publisher ?? null,
    publishedDate: v.publishedDate ?? null,
    description: v.description ?? null,
    pageCount: v.pageCount ?? null,
    thumbnailUrl: thumb ? thumb.replace(/^http:/, 'https:') : null,
    grade: detectGrade(blob),
    source: 'google-books',
  };
}

async function fetchOpenLibrary(isbn: string): Promise<BookMetadata | null> {
  const res = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as Record<
    string,
    {
      title?: string;
      authors?: Array<{ name?: string }>;
      publishers?: Array<{ name?: string }>;
      publish_date?: string;
      notes?: string | { value?: string };
      number_of_pages?: number;
      cover?: { large?: string; medium?: string; small?: string };
    }
  >;
  const v = data[`ISBN:${isbn}`];
  if (!v) return null;
  const notes = typeof v.notes === 'string' ? v.notes : v.notes?.value ?? null;
  return {
    isbn,
    title: v.title ?? null,
    authors: (v.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    publisher: v.publishers?.[0]?.name ?? null,
    publishedDate: v.publish_date ?? null,
    description: notes,
    pageCount: v.number_of_pages ?? null,
    thumbnailUrl: v.cover?.large ?? v.cover?.medium ?? v.cover?.small ?? null,
    grade: detectGrade(v.title ?? ''),
    source: 'open-library',
  };
}

async function fetchOpenLibrarySearch(isbn: string): Promise<BookMetadata | null> {
  const res = await fetch(
    `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    docs?: Array<{
      title?: string;
      author_name?: string[];
      publisher?: string[];
      first_publish_year?: number;
      number_of_pages_median?: number;
      cover_i?: number;
    }>;
  };
  const v = data.docs?.[0];
  if (!v?.title) return null;
  return {
    isbn,
    title: v.title,
    authors: v.author_name ?? [],
    publisher: v.publisher?.[0] ?? null,
    publishedDate: v.first_publish_year ? String(v.first_publish_year) : null,
    description: null,
    pageCount: v.number_of_pages_median ?? null,
    thumbnailUrl: v.cover_i
      ? `https://covers.openlibrary.org/b/id/${v.cover_i}-L.jpg`
      : null,
    grade: detectGrade(v.title),
    source: 'open-library-search',
  };
}

async function fetchLibraryOfCongress(isbn: string): Promise<BookMetadata | null> {
  const url =
    `https://www.loc.gov/search/?q=${encodeURIComponent(isbn)}` +
    `&fo=json&c=1&fa=original-format:Books`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(7000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      contributor?: string[];
      description?: string[];
      date?: string;
      image_url?: string[];
      partof_division?: string[];
    }>;
  };
  const v = data.results?.[0];
  if (!v?.title) return null;
  const authors = (v.contributor ?? [])
    .map((a) => a.replace(/,\s*\d{4}.*$/, '').trim())
    .filter(Boolean);
  const description = (v.description ?? []).join(' ').trim() || null;
  const cover = (v.image_url ?? []).find((u) => /\.(jpe?g|png)/i.test(u)) ?? null;
  return {
    isbn,
    title: v.title,
    authors,
    publisher: v.partof_division?.[0] ?? null,
    publishedDate: v.date ?? null,
    description,
    pageCount: null,
    thumbnailUrl: cover,
    grade: detectGrade(`${v.title} ${description ?? ''}`),
    source: 'library-of-congress',
  };
}

function pickFirst<T>(
  values: ReadonlyArray<T | null | undefined>,
  isEmpty: (v: T) => boolean = (v) => v == null,
): T | null {
  for (const v of values) {
    if (v == null) continue;
    if (isEmpty(v)) continue;
    return v;
  }
  return null;
}

/**
 * Run all four sources in parallel and merge field-by-field. Returns
 * null when no source returned data. Caller decides what to do with
 * a partial-but-titled result.
 */
export async function lookupIsbn(rawIsbn: string): Promise<BookMetadata | null> {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  // Cache-first: a previously-resolved ISBN is served from our own DB with
  // no external calls. Return with the isbn the caller actually passed (the
  // row is keyed by the canonical ISBN-13, which may differ from a scanned
  // ISBN-10) so downstream behaviour is unchanged.
  const cacheKey = canonicalIsbnKey(isbn);
  const cached = await readBookCache(cacheKey);
  if (cached) return { ...cached, isbn };

  const settled = await Promise.allSettled([
    fetchGoogleBooks(isbn),
    fetchOpenLibrary(isbn),
    fetchOpenLibrarySearch(isbn),
    fetchLibraryOfCongress(isbn),
  ]);
  const hits = settled
    .filter((r): r is PromiseFulfilledResult<BookMetadata | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is BookMetadata => v !== null);

  // 5th-source fallback: if all 4 free public APIs returned nothing,
  // try Gemini. Slower (1-2s) and costs tokens, so it only runs as
  // a last resort. The dynamic import keeps this path off the hot
  // module graph so the public lookup endpoint doesn't pay for the
  // Gemini SDK on every successful 4-source hit.
  if (hits.length === 0) {
    const { fetchGeminiBookMetadata } = await import('./lookup-gemini');
    const aiHit = await fetchGeminiBookMetadata(isbn);
    if (aiHit) hits.push(aiHit);
  }

  if (hits.length === 0) return null;

  const titles = hits.map((h) => h.title);
  const authorLists = hits.map((h) => h.authors);
  const publishers = hits.map((h) => h.publisher);
  const dates = hits.map((h) => h.publishedDate);
  const descriptions = hits.map((h) => h.description);
  const pages = hits.map((h) => h.pageCount);
  const thumbs = hits.map((h) => h.thumbnailUrl);
  const grades = hits.map((h) => h.grade);

  const merged: BookMetadata = {
    isbn,
    title: pickFirst(titles, (s) => s.trim().length === 0),
    authors: pickFirst(authorLists, (a) => a.length === 0) ?? [],
    publisher: pickFirst(publishers, (s) => s.trim().length === 0),
    publishedDate: pickFirst(dates, (s) => s.trim().length === 0),
    description: pickFirst(descriptions, (s) => s.trim().length === 0),
    pageCount: pickFirst(pages, (n) => n <= 0),
    thumbnailUrl: pickFirst(thumbs, (s) => s.trim().length === 0),
    grade: pickFirst(grades, (s) => s.trim().length === 0),
    source: hits[0]!.source,
    sources: hits.map((h) => h.source),
  };

  // Persist only titled results from a REAL bibliographic source. An
  // AI-fallback-only ('gemini') result is verified per-request by the
  // hallucination guard and deliberately never cached — we don't want a
  // possibly-wrong AI answer served from cache forever, and a later scan can
  // still resolve it from Google Books / Open Library / LoC.
  const hasRealSource = merged.sources?.some((s) => s !== 'gemini') ?? false;
  if (merged.title && hasRealSource) {
    await writeBookCache(cacheKey, merged);
  }

  return merged;
}
