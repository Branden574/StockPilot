import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { lookupIsbn, normalizeIsbn } from '@/lib/books/lookup';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile flow: scanner saw an ISBN that's not in inventory. Hit this
 * to resolve title/author/cover/publisher via the existing Google
 * Books → Open Library → ISBNDB chain. The mobile app then renders an
 * AddBookCard that one-taps the result into inventory_items.
 *
 * Query: ?isbn=<isbn-10 or isbn-13>
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Per-user throttle: calls paid/quota external APIs (Google Books, Open
  // Library, etc.). 60/min covers rapid book scanning; caps a runaway loop.
  const rl = await checkRateLimit(`isbn-lookup:user:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many lookups — slow down a moment.' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const url = new URL(req.url);
  const raw = (url.searchParams.get('isbn') ?? '').trim();
  if (!raw) {
    return NextResponse.json({ error: 'isbn is required' }, { status: 400 });
  }
  const normalized = normalizeIsbn(raw);
  if (!normalized) {
    return NextResponse.json({ error: 'invalid_isbn' }, { status: 400 });
  }

  // Already in inventory? Surface that so mobile can route to the existing
  // item card instead of offering "Add new."
  const { data: existing } = await ctx.supabase
    .from('inventory_items')
    .select('id, sku, name, quantity_on_hand')
    .eq('organization_id', ctx.organizationId)
    .eq('barcode', normalized)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      isbn: normalized,
      existingItem: {
        id: existing.id,
        sku: existing.sku,
        name: existing.name,
        quantityOnHand: Number(existing.quantity_on_hand) || 0,
      },
      metadata: null,
    });
  }

  try {
    const meta = await lookupIsbn(normalized);
    return NextResponse.json({
      isbn: normalized,
      existingItem: null,
      metadata: meta,
    });
  } catch (e) {
    return NextResponse.json(
      {
        isbn: normalized,
        existingItem: null,
        metadata: null,
        error: e instanceof Error ? e.message : 'lookup_failed',
      },
      { status: 200 },
    );
  }
}
