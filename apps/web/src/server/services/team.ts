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
    warehouseId?: string | null;
    message?: string;
  }) {
    assertPermission(this.ctx, 'members:invite');

    const normalizedEmail = params.email.toLowerCase().trim();

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

    // 8 bytes = 11 base64url chars (~64 bits of entropy). Plenty for a
    // 7-day-expiring single-use invite, AND short enough that the full URL
    // (~57 chars) fits on one line in Teams/Slack/iMessage so the link
    // doesn't visually word-wrap and break.
    const token = randomBytes(8).toString('base64url');
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
        charter_id: params.charterId ?? null,
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
    await audit({
      event: 'user.invited',
      entityType: 'org_invite',
      entityId: invite.id as string,
      after: { resent: true, email: invite.email },
    });
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

    await audit({
      event: 'user.role.changed',
      entityType: 'organization_member',
      entityId: memberId,
      before: { role: target.role },
      after: { role },
    });
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
    const { error } = await this.ctx.supabase
      .from('organization_members')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'user.deactivated',
      entityType: 'organization_member',
      entityId: memberId,
      before: { user_id: target.user_id, role: target.role },
    });
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
      'id, organization_id, email, role, expires_at, accepted_at, warehouse_id, charter_id, invited_by',
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
    let existingQuery = admin
      .from('user_warehouse_assignments')
      .select('id')
      .eq('user_id', userId)
      .eq('warehouse_id', warehouseId);
    existingQuery =
      charterId === null
        ? existingQuery.is('charter_id', null)
        : existingQuery.eq('charter_id', charterId);
    const { data: existing } = await existingQuery.maybeSingle();

    if (!existing) {
      const { error: assignErr } = await admin.from('user_warehouse_assignments').insert({
        organization_id: orgId,
        user_id: userId,
        warehouse_id: warehouseId,
        charter_id: charterId,
        is_primary: true,
        assigned_by: invite.invited_by as string | null,
        assigned_at: now,
      });
      if (assignErr) {
        console.error('[acceptInvite] failed to create warehouse assignment', assignErr);
        // Non-fatal — membership exists, admin can fix assignment later.
      } else {
        await audit({
          event: 'user.warehouse.changed',
          entityType: 'user',
          entityId: userId,
          warehouseId,
          after: { warehouseId, charterId },
        });
      }
    }
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
    },
  });

  return { organizationId: orgId };
}
