import { NextResponse } from 'next/server';

import { lookupIsbn, normalizeIsbn } from '@/lib/books/lookup';

export const runtime = 'nodejs';

/**
 * Public ISBN lookup. Resolves a raw ISBN to merged metadata across
 * Google Books, Open Library, and the Library of Congress. The
 * pipeline lives in lib/books/lookup.ts so the AI tools can call it
 * directly without an HTTP round trip.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('isbn');
  if (!raw) {
    return NextResponse.json({ error: 'Missing isbn param' }, { status: 400 });
  }
  if (!normalizeIsbn(raw)) {
    return NextResponse.json({ error: 'Invalid ISBN format' }, { status: 400 });
  }
  const merged = await lookupIsbn(raw);
  if (!merged) {
    return NextResponse.json(
      { error: 'No metadata found for this ISBN' },
      { status: 404 },
    );
  }
  return NextResponse.json(merged);
}
