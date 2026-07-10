import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Candidate drivers for the assign-delivery step (mobile parity for the web
 * AssignDeliveryDialog) — active org members. Gated on `orders:assign_delivery`,
 * the same permission the assign action enforces, so only assigners see the
 * roster. Returns name/email only (already member-readable via RLS).
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!can(ctx, 'orders:assign_delivery')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const { data: members, error } = await ctx.supabase
      .from('organization_members')
      .select('user_id, is_delivery_driver, user:user_profiles!user_id (id, full_name, email)')
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null);
    if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });

    type MemberRow = {
      user_id: string;
      is_delivery_driver: boolean | null;
      user:
        | { id: string; full_name: string | null; email: string }
        | { id: string; full_name: string | null; email: string }[]
        | null;
    };
    const allStaff = ((members ?? []) as MemberRow[]).flatMap((m) => {
      const u = Array.isArray(m.user) ? m.user[0] : m.user;
      if (!u || typeof u.email !== 'string') return [];
      return [
        {
          id: u.id,
          name: u.full_name?.trim() || u.email,
          email: u.email,
          isDriver: Boolean(m.is_delivery_driver),
        },
      ];
    });
    // Marked delivery drivers only (Team page toggle); all-staff fallback
    // while the org has none marked — mirrors the web order-detail page.
    const marked = allStaff.filter((m) => m.isDriver);
    const drivers = (marked.length > 0 ? marked : allStaff)
      .map(({ id, name, email }) => ({ id, name, email }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ drivers });
  } catch (e) {
    void reportError(e, { tag: 'api.v1.orders.drivers' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
