import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST-only consumer for the public order-request confirmation token.
 *
 * The GET page (`/r/confirm`) renders a click-through form pointing here
 * so email security scanners — which follow GET/HEAD but never submit
 * forms — can't burn the single-use token before the human clicks (see
 * the page's doc comment for the full rationale).
 *
 * This performs exactly the confirm the old GET render used to: hash
 * the plaintext token, call `confirm_public_order_request` (migration
 * 0108) which atomically promotes pending_confirmation →
 * pending_approval and nulls the token hash. Then 303-redirect back to
 * /r/confirm to render the outcome. A plain route handler (not a server
 * action) so a deploy between the email GET and the click can't strand
 * the form on a stale action id.
 */

// Mirror the GET page's param validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const id = (form?.get('id') as string | null) ?? null;
  const token = (form?.get('t') as string | null) ?? null;

  if (!id || !token || !UUID_RE.test(id) || !TOKEN_RE.test(token)) {
    return NextResponse.redirect(`${origin}/r/confirm?e=1`, 303);
  }

  // Hash before the RPC so the plaintext only ever lives in the URL /
  // form (which the recipient already has) — the DB stores hashes only.
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('confirm_public_order_request', {
    p_id: id,
    p_token_hash: tokenHash,
  });

  // A null result covers invalid, expired, AND already-confirmed — the
  // RPC is deliberately ambiguous. A re-POST of a consumed token lands
  // on the "already used" copy of the invalid panel, never an error page.
  if (error || !data) {
    return NextResponse.redirect(`${origin}/r/confirm?e=1`, 303);
  }

  return NextResponse.redirect(`${origin}/r/confirm?done=${id}`, 303);
}
