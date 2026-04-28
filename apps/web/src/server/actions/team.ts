'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { TeamService, acceptInviteWithToken } from '@/server/services/team';
import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import {
  acceptInviteSchema,
  err,
  inviteMemberSchema,
  ok,
  updateMemberRoleSchema,
  type AcceptInviteInput,
  type ActionResult,
  type InviteMemberInput,
  type Role,
  type UpdateMemberRoleInput,
} from '@stockpilot/core';
import { z } from 'zod';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function inviteMemberAction(
  input: InviteMemberInput,
): Promise<ActionResult<{ acceptUrl: string }>> {
  const parsed = inviteMemberSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  if (parsed.data.role === 'owner') return err('forbidden', 'Cannot invite as owner');

  try {
    const session = await requireSession();
    const supabase = await createClient();

    const { data: orgRow } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', session.defaultOrganizationId ?? '')
      .maybeSingle();
    const orgName = (orgRow?.name as string | undefined) ?? 'StockPilot';
    const inviter = session.fullName ?? session.email;

    const svc = await TeamService.forCurrentUser();
    const result = await svc.invite(parsed.data.email, parsed.data.role as Exclude<Role, 'owner'>, orgName, inviter);
    revalidatePath('/dashboard/team');
    return ok({ acceptUrl: result.acceptUrl });
  } catch (e) {
    return toResult(e);
  }
}

export async function revokeInviteAction(inviteId: string): Promise<ActionResult<void>> {
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.revokeInvite(inviteId);
    revalidatePath('/dashboard/team');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function updateMemberRoleAction(
  input: UpdateMemberRoleInput,
): Promise<ActionResult<void>> {
  const parsed = updateMemberRoleSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.updateMemberRole(parsed.data.memberId, parsed.data.role);
    revalidatePath('/dashboard/team');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const removeMemberSchema = z.object({ memberId: z.string().uuid() });

export async function removeMemberAction(memberId: string): Promise<ActionResult<void>> {
  const parsed = removeMemberSchema.safeParse({ memberId });
  if (!parsed.success) return err('validation_error', 'Invalid member id');
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.removeMember(parsed.data.memberId);
    revalidatePath('/dashboard/team');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function acceptInviteAction(input: AcceptInviteInput): Promise<ActionResult<{ organizationId: string }>> {
  const parsed = acceptInviteSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid token');
  try {
    const session = await requireSession();
    const result = await acceptInviteWithToken(parsed.data.token, session.userId);
    revalidatePath('/dashboard');
    return ok({ organizationId: result.organizationId });
  } catch (e) {
    return toResult(e);
  }
}

