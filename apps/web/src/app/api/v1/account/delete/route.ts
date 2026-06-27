import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';

export const runtime = 'nodejs';

/**
 * Mobile-facing self-deletion endpoint. Mirrors the web's
 * `deleteOwnAccountAction` server action, but authenticated via the
 * standard mobile bearer-token flow (withApiContext) instead of a
 * Next.js session cookie.
 *
 * Apple App Store Review Guideline 5.1.1(v) requires apps with
 * account creation to also expose account deletion inside the app —
 * not just on a website. This route is what the mobile Settings →
 * Delete account button calls.
 *
 * Contract:
 *   POST /api/v1/account/delete
 *   body: { confirm: "DELETE" }
 *   200: { ok: true }
 *   400: { error: "validation_error", message }
 *   403: { error: "forbidden", message }       // sole-owner with co-members
 *   500: { error: "internal_error", message }
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Enforce the org's MFA policy before this destructive action, matching the
  // web `deleteOwnAccountAction` gateMfa() check. withApiContext resolves
  // mfaRequired/mfaSatisfied but the route must act on them — otherwise an
  // AAL1 bearer token could delete the account under an MFA-required policy.
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return NextResponse.json(
      { error: 'mfa_required', message: 'Multi-factor authentication required.' },
      { status: 403 },
    );
  }

  let body: { confirm?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body falls through to validation error
  }

  if (body.confirm !== 'DELETE') {
    return NextResponse.json(
      { error: 'validation_error', message: 'Type DELETE to confirm.' },
      { status: 400 },
    );
  }

  try {
    // Refuse the delete if the user is the sole accepted owner of an
    // org that still has other accepted members — they must transfer
    // ownership first. Same rule as the web action.
    const { data: ownedRows } = await ctx.supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', ctx.userId)
      .eq('role', 'owner')
      .not('accepted_at', 'is', null);
    const ownedOrgIds = ((ownedRows as { organization_id: string }[] | null) ?? []).map(
      (r) => r.organization_id,
    );
    if (ownedOrgIds.length > 0) {
      const { data: otherMembers } = await ctx.supabase
        .from('organization_members')
        .select('organization_id')
        .in('organization_id', ownedOrgIds)
        .neq('user_id', ctx.userId)
        .not('accepted_at', 'is', null)
        .limit(1);
      if ((otherMembers ?? []).length > 0) {
        return NextResponse.json(
          {
            error: 'forbidden',
            message:
              'Transfer ownership of your organization (or remove the other members) before deleting your account.',
          },
          { status: 403 },
        );
      }
    }

    // Soft-delete profile first so audit / movement rows retain a
    // tombstoned reference. The cascading FK in auth.users will
    // hard-delete the rest when admin.deleteUser fires.
    const deletedAt = new Date().toISOString();
    const { error: profileErr } = await ctx.supabase
      .from('user_profiles')
      .update({ deleted_at: deletedAt })
      .eq('id', ctx.userId);
    if (profileErr) {
      return NextResponse.json(
        { error: 'internal_error', message: profileErr.message },
        { status: 500 },
      );
    }

    await audit({
      event: 'user.deactivated',
      entityType: 'user',
      entityId: ctx.userId,
      reason: 'self_deletion_mobile',
    });

    const admin = createAdminClient();
    const { error: authErr } = await admin.auth.admin.deleteUser(ctx.userId);
    if (authErr) {
      // Same logic as the web action: profile tombstone already blocks
      // login, so we log and return success rather than producing a
      // half-deleted UX state the user can't recover from.
      console.error('[v1/account/delete] auth.admin.deleteUser failed:', authErr.message);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      {
        error: 'internal_error',
        message: e instanceof Error ? e.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
