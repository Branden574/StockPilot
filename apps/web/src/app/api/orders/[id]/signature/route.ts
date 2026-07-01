import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lazily returns the captured signature (data-URL PNG) for one order. The
 * order-detail page used to serialize this base64 blob into the RSC flight
 * payload on every render for manager/driver viewers, even though it's only
 * ever seen inside a closed-by-default dialog. Fetching it on dialog-open
 * keeps the blob out of the initial payload.
 *
 * Auth: the user-scoped client means RLS already restricts the row to the
 * caller's org — same gate as the page's read. Returns null if the order
 * isn't in the caller's org or isn't signed.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = await ctx.supabase
    .from('order_requests')
    .select('signature_data_url')
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  return NextResponse.json({
    signatureDataUrl: (data as { signature_data_url: string | null } | null)?.signature_data_url ?? null,
  });
}
