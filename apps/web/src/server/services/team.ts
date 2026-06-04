import 'server-only';

import { randomBytes } from 'node:crypto';

import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/resend';
import { inviteEmailHtml, inviteEmailText } from '@/lib/email/templates';
import { createAdminClient } from '@/lib/supabase/admin';

import { type Role } from '@stockpilot/core';

import { audit } from './audit';
import {
  assertPermission,
  assertRoleUnchanged,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export class TeamService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new TeamService(await withContext());
  }

  async listMembers() {
    const { data, error } = await this.ctx.supabase
      .from('organization_members')
      .select(
        `
        id, role, invited_at, accepted_at, created_at, user_id,
        user:user_id (id, email, full_name, avatar_url)
      `,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((m: Record<string, unknown>) => {
      const userField = m.user;
      const userObj = Array.isArray(userField) ? userField[0] : userField;
      return {
        id: m.id as string,
        role: m.role as Role,
        invited_at: (m.invited_at as string | null) ?? null,
        accepted_at: (m.accepted_at as string | null) ?? null,
        created_at: m.created_at as string,
        user_id: m.user_id as string,
        user:
          userObj && typeof userObj === 'object'
            ? {
                id: (userObj as { id: string }).id,
                email: (userObj as { email: string }).email,
                full_name: ((userObj as { full_name?: string | null }).full_name ?? null) as string | null,
                avatar_url: ((userObj as { avatar_url?: string | null }).avatar_url ?? null) as string | null,
              }
            : null,
      };
    });
  }

  async listPendingInvites() {
    // C10: gate explicitly on `members:invite` (admin+). RLS already
    // blocks non-admins from selecting `organization_invites`, so the
    // observable behavior is identical — the assert just makes intent
    // explicit and gives non-admins a clean forbidden instead of an
    // empty list.
    assertPermission(this.ctx, 'members:invite');
    const { data, error } = await this.ctx.supabase
      .from('organization_invites')
      .select('id, email, role, token, expires_at, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async invite(params: {
    email: string;
    role: Exclude<Role, 'owner'>;
    organizationName: string;
    inviterName: string;
    charterId?: string | null;
    /**
     * Multi-charter invite: the charters this user will oversee for the
     * assigned warehouse. Takes precedence over the single `charterId`
     * when non-empty. On accept, one assignment row is created per charter.
     */
    charterIds?: string[];
    warehouseId?: string | null;
    message?: string;
  }) {
    assertPermission(this.ctx, 'members:invite');

    const normalizedEmail = params.email.toLowerCase().trim();

    // Normalize the charter list: prefer the explicit multi list, else
    // fall back to the single charterId (back-compat), else empty (= all
    // charters). filter(Boolean) drops nulls/empties.
    const charterIds = (
      params.charterIds ?? (params.charterId ? [params.charterId] : [])
    ).filter(Boolean) as string[];

    // For warehouse-scoped roles (staff/viewer), warehouse_id is required.
    if ((params.role === 'staff' || params.role === 'viewer') && !params.warehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be assigned for Warehouse User and Read-Only Auditor roles.',
      );
    }

    // Already a member?
    const { data: existingMember } = await this.ctx.supabase
      .from('user_profiles')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (existingMember) {
      const { data: existingMembership } = await this.ctx.supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', existingMember.id as string)
        .maybeSingle();
      if (existingMembership) {
        throw new ServiceError('conflict', 'That email is already a member.');
      }
    }

    // Already invited and not yet expired?
    const { data: existingInvite } = await this.ctx.supabase
      .from('organization_invites')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('email', normalizedEmail)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (existingInvite) {
      throw new ServiceError('conflict', 'An active invite already exists for that email.');
    }

    // 16 bytes = 22 base64url chars (~128 bits of entropy). Matches the
    // 256-bit standard used elsewhere (order-requests public_request_token)
    // and removes the brute-forceable narrowness of an 8-byte token. Still
    // short enough that /i/<token> fits on a single line in Teams/Slack/iMessage.
    const token = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await this.ctx.supabase
      .from('organization_invites')
      .insert({
        organization_id: this.ctx.organizationId,
        email: normalizedEmail,
        role: params.role,
        token,
        expires_at: expiresAt,
        invited_by: this.ctx.userId,
        warehouse_id: params.warehouseId ?? null,
        // Multi-charter list (preferred) + single charter_id (back-compat
        // for older accept paths / readers). charter_ids takes precedence
        // on accept when set.
        charter_ids: charterIds.length > 0 ? charterIds : null,
        charter_id: charterIds[0] ?? null,
        message: params.message ?? null,
      })
      .select('id, token')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);

    const { organizationName, inviterName } = params;

    // Short alias /i/<token> redirects to /invite/<token>; keeps the URL
    // on one line in chat clients so the entire link stays clickable.
    const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/i/${token}`;
    await sendEmail({
      to: normalizedEmail,
      subject: `You're invited to join ${organizationName} on StockPilot`,
      html: inviteEmailHtml({ organizationName, inviterName, acceptUrl }),
      text: inviteEmailText({ organizationName, inviterName, acceptUrl }),
    });

    return { id: invite.id as string, token: invite.token as string, acceptUrl };
  }

  async revokeInvite(inviteId: string) {
    assertPermission(this.ctx, 'members:invite');
    const { error } = await this.ctx.supabase
      .from('organization_invites')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', inviteId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Re-sends the invite email for an existing pending invite. Same
   * token, same accept URL — the recipient still uses the link they
   * would've gotten the first time. Useful when the original email
   * was lost in spam, deleted, or never delivered. Bumps expires_at
   * to a fresh 7 days from now so a stale invite doesn't expire mid-
   * onboarding.
   */
  async resendInvite(inviteId: string): Promise<{ acceptUrl: string }> {
    assertPermission(this.ctx, 'members:invite');

    const { data: invite, error: fetchErr } = await this.ctx.supabase
      .from('organization_invites')
      .select(
        `id, email, token, accepted_at, organizations:organization_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', inviteId)
      .maybeSingle();
    if (fetchErr) throw new ServiceError('internal_error', fetchErr.message);
    if (!invite) throw new ServiceError('not_found', 'Invite not found');
    if (invite.accepted_at) {
      throw new ServiceError(
        'conflict',
        'This invite has already been accepted — no need to resend.',
      );
    }

    // Refresh the expiry so a recipient who acts on a re-sent email
    // doesn't immediately hit "invite expired".
    const { error: updErr } = await this.ctx.supabase
      .from('organization_invites')
      .update({
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', inviteId);
    if (updErr) throw new ServiceError('internal_error', updErr.message);

    // Inviter name: prefer current user's full_name, fallback to email.
    const { data: profile } = await this.ctx.supabase
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', this.ctx.userId)
      .maybeSingle();
    const inviterName =
      (profile?.full_name as string | null) ??
      (profile?.email as string | null) ??
      'Your teammate';

    // organizations is returned as either an object or an array depending
    // on whether the embed is one-or-many — flatten.
    const orgField = invite.organizations as
      | { name: string }
      | { name: string }[]
      | null;
    const organizationName =
      (Array.isArray(orgField) ? orgField[0]?.name : orgField?.name) ??
      'StockPilot';

    const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/i/${invite.token as string}`;
    await sendEmail({
      to: invite.email as string,
      subject: `Reminder: you're invited to join ${organizationName} on StockPilot`,
      html: inviteEmailHtml({ organizationName, inviterName, acceptUrl }),
      text: inviteEmailText({ organizationName, inviterName, acceptUrl }),
    });
    await audit(
      {
        event: 'user.invited',
        entityType: 'org_invite',
        entityId: invite.id as string,
        after: { resent: true, email: invite.email },
      },
      this.ctx,
    );
    return { acceptUrl };
  }

  async updateMemberRole(memberId: string, role: Role) {
    assertPermission(this.ctx, 'members:update_role');
    await assertRoleUnchanged(this.ctx);
    if (role === 'owner') {
      throw new ServiceError('forbidden', 'Use transferOwnership to assign owner');
    }

    // Self-mod block: a user cannot change their own role even if they
    // hold members:update_role. Prevents the only-admin from accidentally
    // demoting themselves and locking the org.
    const { data: target } = await this.ctx.supabase
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId)
      .maybeSingle();
    if (!target) throw new ServiceError('not_found', 'Member not found');
    if ((target.role as string) === 'owner') {
      throw new ServiceError(
        'forbidden',
        'The owner role can only be reassigned via a separate ownership-transfer flow.',
      );
    }
    if ((target.user_id as string) === this.ctx.userId) {
      throw new ServiceError(
        'forbidden',
        'You cannot change your own role. Ask another admin.',
      );
    }

    const { error } = await this.ctx.supabase
      .from('organization_members')
      .update({ role })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit(
      {
        event: 'user.role.changed',
        entityType: 'organization_member',
        entityId: memberId,
        before: { role: target.role },
        after: { role },
      },
      this.ctx,
    );
  }

  async removeMember(memberId: string) {
    assertPermission(this.ctx, 'members:remove');
    await assertRoleUnchanged(this.ctx);
    const { data: target } = await this.ctx.supabase
      .from('organization_members')
      .select('role, user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId)
      .maybeSingle();
    if (!target) throw new ServiceError('not_found', 'Member not found');
    if ((target.role as string) === 'owner') {
      throw new ServiceError('forbidden', 'Cannot remove the owner');
    }
    if ((target.user_id as string) === this.ctx.userId) {
      throw new ServiceError(
        'forbidden',
        'You cannot remove your own membership. Ask another admin.',
      );
    }
    const removedUserId = target.user_id as string;
    const { error } = await this.ctx.supabase
      .from('organization_members')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId);
    if (error) throw new ServiceError('internal_error', error.message);

    // Belt-and-braces cleanup of per-warehouse access grants for the
    // removed user inside THIS organization. Most other org-scoped
    // rows are already locked down by RLS once the membership row is
    // gone, but `user_warehouse_assignments` is keyed only by
    // (user_id, warehouse_id) and we don't want a stale assignment
    // resurfacing if the same user is re-invited later. Best-effort:
    // a failure here doesn't undo the membership removal, but we
    // surface it through the audit trail.
    let assignmentsCleared = 0;
    let sessionRevoked = false;
    try {
      const admin = createAdminClient();

      // Warehouses in this org
      const { data: orgWarehouses } = await admin
        .from('warehouses')
        .select('id')
        .eq('organization_id', this.ctx.organizationId);
      const warehouseIds = (orgWarehouses ?? []).map(
        (w) => w.id as string,
      );
      if (warehouseIds.length > 0) {
        const { data: cleared, error: clearErr } = await admin
          .from('user_warehouse_assignments')
          .delete()
          .eq('user_id', removedUserId)
          .in('warehouse_id', warehouseIds)
          .select('warehouse_id');
        if (!clearErr) {
          assignmentsCleared = (cleared ?? []).length;
        }
      }

      // Kill the removed user's auth sessions globally. This forces
      // them to sign in again — at which point RLS + missing
      // membership row will keep them out of this org. If the user
      // belongs to multiple orgs we accept the collateral sign-out
      // (rare; org membership is invite-only and most users only
      // belong to a single workspace).
      const { error: signOutErr } = await admin.auth.admin.signOut(
        removedUserId,
        'global',
      );
      sessionRevoked = !signOutErr;
    } catch {
      // No admin client (missing SUPABASE_SERVICE_ROLE_KEY) or
      // network failure. Membership row deletion already happened,
      // so the user is logically out; they just keep their existing
      // session cookie until it expires naturally.
    }

    await audit(
      {
        event: 'user.deactivated',
        entityType: 'organization_member',
        entityId: memberId,
        before: { user_id: removedUserId, role: target.role },
        extra: {
          assignments_cleared: assignmentsCleared,
          session_revoked: sessionRevoked,
        },
      },
      this.ctx,
    );

    if (sessionRevoked) {
      // Emit a dedicated session-invalidation audit row so the audit
      // log clearly shows the kicked user's sessions were revoked
      // (separate from the membership removal entry above).
      await audit(
        {
          event: 'user.session.invalidated',
          entityType: 'user',
          entityId: removedUserId,
          extra: { reason: 'member_removed' },
        },
        this.ctx,
      );
    }
  }

  /**
   * Replaces the set of charters an existing member oversees for a single
   * warehouse. Reconciles `user_warehouse_assignments`:
   *   - target set = deduped `charterIds`, or `[null]` (all-charters) when empty;
   *   - DELETE assignment rows whose charter_id is NOT in the target set;
   *   - INSERT rows for target charters that are missing;
   *   - leave exactly one remaining row flagged `is_primary`.
   *
   * Gated on `members:invite` — the same permission `invite()` requires to
   * create these rows. `members:invite` is admin+ (owner/admin), which also
   * matches the `uwa_admin_write` RLS write floor on
   * `user_warehouse_assignments`, so the user-scoped (ctx) client can both
   * read and write here with RLS enforced as defense-in-depth.
   */
  async setMemberCharterAssignments(params: {
    userId: string;
    warehouseId: string;
    charterIds: string[]; // empty = "all charters" (a single null-charter row)
  }): Promise<void> {
    assertPermission(this.ctx, 'members:invite');

    if (!params.warehouseId) {
      throw new ServiceError('validation_error', 'A warehouse is required.');
    }

    // Defense in depth: confirm the target is a member of THIS org (RLS
    // would also block cross-org assignment writes, but this gives a
    // friendlier error).
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', params.userId)
      .maybeSingle();
    if (!member) {
      throw new ServiceError('not_found', 'User is not a member of this organization.');
    }

    // Defense in depth: confirm the warehouse belongs to THIS org.
    const { data: warehouse } = await this.ctx.supabase
      .from('warehouses')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', params.warehouseId)
      .maybeSingle();
    if (!warehouse) {
      throw new ServiceError('not_found', 'Warehouse not found in this organization.');
    }

    // Target set of charter_ids. Empty input means "all charters", which is
    // represented as a single row with charter_id = null. Dedupe input.
    const deduped = Array.from(new Set(params.charterIds.filter(Boolean)));
    const target: Array<string | null> =
      deduped.length > 0 ? deduped : [null];

    // Read existing assignment rows for (org, user, warehouse).
    const { data: existingRows, error: readErr } = await this.ctx.supabase
      .from('user_warehouse_assignments')
      .select('id, charter_id, is_primary')
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', params.userId)
      .eq('warehouse_id', params.warehouseId);
    if (readErr) throw new ServiceError('internal_error', readErr.message);

    const existing = (existingRows ?? []) as Array<{
      id: string;
      charter_id: string | null;
      is_primary: boolean | null;
    }>;
    const before = existing.map((r) => r.charter_id);

    const targetKey = (c: string | null) => c ?? '__null__';
    const targetSet = new Set(target.map(targetKey));
    const existingSet = new Set(existing.map((r) => targetKey(r.charter_id)));

    // DELETE rows whose charter isn't in the target set.
    const toDelete = existing.filter((r) => !targetSet.has(targetKey(r.charter_id)));
    if (toDelete.length > 0) {
      const { error: delErr } = await this.ctx.supabase
        .from('user_warehouse_assignments')
        .delete()
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', params.userId)
        .eq('warehouse_id', params.warehouseId)
        .in(
          'id',
          toDelete.map((r) => r.id),
        );
      if (delErr) throw new ServiceError('internal_error', delErr.message);
    }

    // INSERT rows for target charters that don't already exist.
    const toInsert = target.filter((c) => !existingSet.has(targetKey(c)));
    if (toInsert.length > 0) {
      const now = new Date().toISOString();
      const { error: insErr } = await this.ctx.supabase
        .from('user_warehouse_assignments')
        .insert(
          toInsert.map((charterId) => ({
            organization_id: this.ctx.organizationId,
            user_id: params.userId,
            warehouse_id: params.warehouseId,
            charter_id: charterId,
            is_primary: false,
            assigned_by: this.ctx.userId,
            assigned_at: now,
          })),
        );
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    // Ensure exactly one remaining row is flagged primary. Re-read the
    // surviving rows; if none is primary, promote the first.
    const { data: finalRows } = await this.ctx.supabase
      .from('user_warehouse_assignments')
      .select('id, charter_id, is_primary')
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', params.userId)
      .eq('warehouse_id', params.warehouseId)
      .order('assigned_at', { ascending: true });
    const surviving = (finalRows ?? []) as Array<{
      id: string;
      charter_id: string | null;
      is_primary: boolean | null;
    }>;
    const primaryCandidate = surviving[0];
    if (primaryCandidate && !surviving.some((r) => r.is_primary)) {
      const { error: primErr } = await this.ctx.supabase
        .from('user_warehouse_assignments')
        .update({ is_primary: true })
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', primaryCandidate.id);
      if (primErr) throw new ServiceError('internal_error', primErr.message);
    }

    await audit(
      {
        event: 'user.warehouse.changed',
        entityType: 'user',
        entityId: params.userId,
        warehouseId: params.warehouseId,
        before: { charterIds: before },
        after: { charterIds: target },
      },
      this.ctx,
    );
  }
}

/**
 * Validates and consumes an invite token, then creates the membership.
 * Uses the admin client because the recipient may not yet have RLS access
 * to organization_invites for this org.
 */
export async function acceptInviteWithToken(token: string, userId: string) {
  const admin = createAdminClient();

  const { data: invite, error: inviteErr } = await admin
    .from('organization_invites')
    .select(
      'id, organization_id, email, role, expires_at, accepted_at, warehouse_id, charter_id, charter_ids, invited_by',
    )
    .eq('token', token)
    .maybeSingle();
  if (inviteErr) throw new ServiceError('internal_error', inviteErr.message);
  if (!invite) throw new ServiceError('not_found', 'Invite not found');
  if (invite.accepted_at) throw new ServiceError('conflict', 'Invite already accepted');
  if (new Date(invite.expires_at as string).getTime() < Date.now()) {
    throw new ServiceError('validation_error', 'Invite has expired');
  }

  // Get user email to confirm match.
  const { data: profile } = await admin
    .from('user_profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) throw new ServiceError('not_found', 'User profile missing');
  if ((profile.email as string).toLowerCase() !== (invite.email as string).toLowerCase()) {
    throw new ServiceError('forbidden', 'Invite is for a different email address');
  }

  const orgId = invite.organization_id as string;
  const role = invite.role as Role;
  const warehouseId = (invite.warehouse_id as string | null) ?? null;
  const charterId = (invite.charter_id as string | null) ?? null;
  const now = new Date().toISOString();

  // Charters to assign: prefer the multi list (charter_ids) if present;
  // else the single charter_id; else [null] (= all-charters, today's
  // behavior). One assignment row is created per entry below.
  const inviteCharterIds: Array<string | null> = (
    (invite.charter_ids as string[] | null) ?? []
  ).filter(Boolean);
  const charters: Array<string | null> =
    inviteCharterIds.length > 0 ? inviteCharterIds : [charterId];

  // Create membership (idempotent on unique constraint).
  const { error: memberErr } = await admin
    .from('organization_members')
    .upsert(
      {
        organization_id: orgId,
        user_id: userId,
        role,
        invited_by: invite.invited_by as string | null,
        accepted_at: now,
      },
      { onConflict: 'organization_id,user_id' },
    );
  if (memberErr) throw new ServiceError('internal_error', memberErr.message);

  // For warehouse-scoped roles, create the user_warehouse_assignment row.
  // For manager+ roles, the assignment is informational (they have implicit
  // access to all warehouses anyway) but we still record the "home" warehouse.
  //
  // Migration 0008 dropped the (user, warehouse) unique constraint and added
  // partial uniques per charter. If the exact (user, warehouse, charter) row
  // already exists we treat the invite as a no-op assignment.
  if (warehouseId) {
    // One assignment row per charter. is_primary is set true only on the
    // FIRST row we actually create (rest false). Best-effort per charter:
    // a single insert failure is logged and skipped (membership already
    // exists, an admin can repair assignments later).
    let primaryAssigned = false;
    for (const thisCharter of charters) {
      let existingQuery = admin
        .from('user_warehouse_assignments')
        .select('id')
        .eq('user_id', userId)
        .eq('warehouse_id', warehouseId);
      existingQuery =
        thisCharter === null
          ? existingQuery.is('charter_id', null)
          : existingQuery.eq('charter_id', thisCharter);
      const { data: existing } = await existingQuery.maybeSingle();

      if (!existing) {
        const { error: assignErr } = await admin.from('user_warehouse_assignments').insert({
          organization_id: orgId,
          user_id: userId,
          warehouse_id: warehouseId,
          charter_id: thisCharter,
          is_primary: !primaryAssigned,
          assigned_by: invite.invited_by as string | null,
          assigned_at: now,
        });
        if (assignErr) {
          console.error('[acceptInvite] failed to create warehouse assignment', assignErr);
          // Non-fatal — membership exists, admin can fix assignment later.
        } else {
          primaryAssigned = true;
        }
      }
    }

    await audit({
      event: 'user.warehouse.changed',
      entityType: 'user',
      entityId: userId,
      warehouseId,
      after: { warehouseId, charterIds: charters },
    });
  }

  // Mark invite accepted.
  await admin.from('organization_invites').update({ accepted_at: now }).eq('id', invite.id as string);

  // If user has no default org, set this as default.
  const { data: prof2 } = await admin
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', userId)
    .maybeSingle();
  if (prof2 && !(prof2.default_organization_id as string | null)) {
    await admin
      .from('user_profiles')
      .update({ default_organization_id: orgId })
      .eq('id', userId);
  }

  // Audit log — invite accepted.
  await admin.from('audit_logs').insert({
    organization_id: orgId,
    user_id: userId,
    event: 'user.invite.accepted',
    metadata: {
      invite_id: invite.id,
      role,
      warehouse_id: warehouseId,
      charter_id: charterId,
      charter_ids: charters,
    },
  });

  return { organizationId: orgId };
}
