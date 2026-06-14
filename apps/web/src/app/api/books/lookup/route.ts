import { NextResponse } from 'next/server';

import { lookupIsbn, normalizeIsbn } from '@/lib/books/lookup';
import { clientIpFromRequest } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';

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
  // This endpoint is PUBLIC and fans out to 3 external book APIs + a paid
  // metadata-merge per call — rate-limit per IP (fail-CLOSED so a DB outage
  // can't unlock unlimited amplification/cost).
  const ip = clientIpFromRequest(request);
  const rl = await checkRateLimit(`books-lookup:${ip}`, 30, 60_000, 'closed');
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
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
