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
  source: 'google-books' | 'open-library';
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

  try {
    const google = await fetchGoogleBooks(isbn).catch(() => null);
    if (google) return NextResponse.json(google);
    const ol = await fetchOpenLibrary(isbn).catch(() => null);
    if (ol) return NextResponse.json(ol);
    return NextResponse.json({ error: 'No metadata found for this ISBN' }, { status: 404 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Lookup failed' },
      { status: 500 },
    );
  }
}
