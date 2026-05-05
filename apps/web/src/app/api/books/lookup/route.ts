import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface BookMetadata {
  isbn: string;
  title: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  pageCount: number | null;
  thumbnailUrl: string | null;
  source:
    | 'google-books'
    | 'open-library'
    | 'open-library-search'
    | 'library-of-congress';
}

function normalizeIsbn(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
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
  const v = data.items?.[0]?.volumeInfo;
  if (!v) return null;
  const thumb = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? null;
  return {
    isbn,
    title: v.title ?? null,
    authors: v.authors ?? [],
    publisher: v.publisher ?? null,
    publishedDate: v.publishedDate ?? null,
    description: v.description ?? null,
    pageCount: v.pageCount ?? null,
    thumbnailUrl: thumb ? thumb.replace(/^http:/, 'https:') : null,
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
    source: 'library-of-congress',
  };
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

  // Try sources in priority order; first hit wins. Each is a free,
  // keyless public API. Order is: broadest consumer coverage first
  // (Google Books → Open Library), then the search-style fallbacks
  // that catch academic/textbook ISBNs.
  const sources: Array<() => Promise<BookMetadata | null>> = [
    () => fetchGoogleBooks(isbn),
    () => fetchOpenLibrary(isbn),
    () => fetchOpenLibrarySearch(isbn),
    () => fetchLibraryOfCongress(isbn),
  ];

  try {
    for (const source of sources) {
      const hit = await source().catch(() => null);
      if (hit) return NextResponse.json(hit);
    }
    return NextResponse.json(
      { error: 'No metadata found for this ISBN' },
      { status: 404 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Lookup failed' },
      { status: 500 },
    );
  }
}
