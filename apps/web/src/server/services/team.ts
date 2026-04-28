import 'server-only';

import { randomBytes } from 'node:crypto';

import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/resend';
import { inviteEmailHtml, inviteEmailText } from '@/lib/email/templates';
import { createAdminClient } from '@/lib/supabase/admin';

import { type Role } from '@stockpilot/core';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

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

  async invite(email: string, role: Exclude<Role, 'owner'>, organizationName: string, inviterName: string) {
    assertPermission(this.ctx, 'members:invite');

    const normalizedEmail = email.toLowerCase().trim();

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

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await this.ctx.supabase
      .from('organization_invites')
      .insert({
        organization_id: this.ctx.organizationId,
        email: normalizedEmail,
        role,
        token,
        expires_at: expiresAt,
        invited_by: this.ctx.userId,
      })
      .select('id, token')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);

    const acceptUrl = `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
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

  async updateMemberRole(memberId: string, role: Role) {
    assertPermission(this.ctx, 'members:update_role');
    if (role === 'owner') {
      throw new ServiceError('forbidden', 'Use transferOwnership to assign owner');
    }
    const { error } = await this.ctx.supabase
      .from('organization_members')
      .update({ role })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async removeMember(memberId: string) {
    assertPermission(this.ctx, 'members:remove');
    // Don't allow removing self if owner. Other guards live in RLS + role rank checks.
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
    const { error } = await this.ctx.supabase
      .from('organization_members')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId);
    if (error) throw new ServiceError('internal_error', error.message);
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
    .select('id, organization_id, email, role, expires_at, accepted_at')
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

  const now = new Date().toISOString();

  // Create membership (idempotent on unique constraint).
  const { error: memberErr } = await admin
    .from('organization_members')
    .upsert(
      {
        organization_id: invite.organization_id as string,
        user_id: userId,
        role: invite.role as Role,
        invited_by: null,
        accepted_at: now,
      },
      { onConflict: 'organization_id,user_id' },
    );
  if (memberErr) throw new ServiceError('internal_error', memberErr.message);

  // Mark invite accepted.
  await admin
    .from('organization_invites')
    .update({ accepted_at: now })
    .eq('id', invite.id as string);

  // If user has no default org, set this as default.
  const { data: prof2 } = await admin
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', userId)
    .maybeSingle();
  if (prof2 && !(prof2.default_organization_id as string | null)) {
    await admin
      .from('user_profiles')
      .update({ default_organization_id: invite.organization_id as string })
      .eq('id', userId);
  }

  return { organizationId: invite.organization_id as string };
}
