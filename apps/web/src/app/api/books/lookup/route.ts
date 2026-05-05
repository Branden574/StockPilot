import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type LookupSource =
  | 'google-books'
  | 'open-library'
  | 'open-library-search'
  | 'library-of-congress';

interface BookMetadata {
  isbn: string;
  title: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  pageCount: number | null;
  thumbnailUrl: string | null;
  /** Detected K-12 / college grade level when the title or subjects mention one. */
  grade: string | null;
  source: LookupSource;
  /** Every source that successfully returned data; useful for debugging. */
  sources?: LookupSource[];
}

function normalizeIsbn(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
  return null;
}

/**
 * Tries to extract a K-12 / college grade level from a title or subject
 * blob. K-12 textbooks usually announce it directly: "Into Literature
 * Grade 12", "Wonders Grade 4 Student Book", etc. Returns one of:
 *   "K", "1".."12", "College", or null.
 */
function detectGrade(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const s = blob.toLowerCase();
  // "grade 12" / "grade k" / "g12" / "12th grade"
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
  const res = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
    { signal: AbortSignal.timeout(5000) },
  );
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
      };
    }>;
  };
  const v = data.items?.[0]?.volumeInfo as
    | {
        title?: string;
        authors?: string[];
        publisher?: string;
        publishedDate?: string;
        description?: string;
        pageCount?: number;
        imageLinks?: { thumbnail?: string; smallThumbnail?: string };
        categories?: string[];
      }
    | undefined;
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

/**
 * Open Library *search* endpoint — different from the books API above.
 * Sometimes catches editions the books endpoint doesn't (older or
 * republished editions), so it's worth trying as a separate hop.
 */
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

/**
 * Library of Congress search. Best free source for US educational and
 * academic publishers (HMH, Pearson, McGraw-Hill, Bedford/St. Martin's,
 * etc.) that consumer book databases skip.
 *
 * The /search endpoint accepts free-text queries; we use q=<isbn> and
 * narrow to format:Books to filter out scores, maps, and recordings
 * that share an ISBN. Results are JSON.
 */
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
  // LoC contributors come in "Lastname, Firstname, dates" form — clean
  // up the trailing date suffix so "Smith, John, 1942-" → "Smith, John".
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

/**
 * Picks the first non-empty value across an ordered list of candidates.
 * "Empty" = null/undefined or empty string for scalars, empty array for
 * arrays. Used to merge fields across sources so a missing description
 * from Google Books can be filled in from Library of Congress without
 * losing the title that Google Books provided first.
 */
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('isbn');
  if (!raw) {
    return NextResponse.json({ error: 'Missing isbn param' }, { status: 400 });
  }
  const isbn = normalizeIsbn(raw);
  if (!isbn) {
    return NextResponse.json({ error: 'Invalid ISBN format' }, { status: 400 });
  }

  // All four sources in parallel — each is a free keyless public API
  // with its own AbortSignal.timeout(). Allowing up to ~7s for the
  // slowest (LoC) means the whole lookup is bounded by that, not by
  // the sum of the individual timeouts.
  const settled = await Promise.allSettled([
    fetchGoogleBooks(isbn),
    fetchOpenLibrary(isbn),
    fetchOpenLibrarySearch(isbn),
    fetchLibraryOfCongress(isbn),
  ]);
  const hits: BookMetadata[] = settled
    .filter((r): r is PromiseFulfilledResult<BookMetadata | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is BookMetadata => v !== null);

  if (hits.length === 0) {
    return NextResponse.json(
      { error: 'No metadata found for this ISBN' },
      { status: 404 },
    );
  }

  // Field-by-field priority order. Google Books usually has the richest
  // description and cover for trade books; Open Library is broader on
  // older titles; LoC carries authoritative author + publisher data for
  // US academic/educational publishers.
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
    // Take the first non-empty author list. Don't union across sources
    // because formats differ (initials vs full names) and merging
    // produces near-duplicates that look like co-authors.
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

  return NextResponse.json(merged);
}
