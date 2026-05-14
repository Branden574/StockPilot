'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { TeamService, acceptInviteWithToken } from '@/server/services/team';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
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
    const result = await svc.invite({
      email: parsed.data.email,
      role: parsed.data.role as Exclude<Role, 'owner'>,
      organizationName: orgName,
      inviterName: inviter,
      charterId: parsed.data.charterId ?? null,
      warehouseId: parsed.data.warehouseId ?? null,
      message: parsed.data.message,
    });
    revalidatePath('/dashboard/team');
    revalidatePath('/dashboard/admin/audit');
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

export async function resendInviteAction(
  inviteId: string,
): Promise<ActionResult<{ acceptUrl: string }>> {
  try {
    const svc = await TeamService.forCurrentUser();
    const result = await svc.resendInvite(inviteId);
    revalidatePath('/dashboard/team');
    return ok(result);
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

const acceptInviteWithSignupSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
  fullName: z.string().min(1).max(120).optional(),
});

/**
 * Combined sign-up + invite-acceptance flow.
 *
 * This is the ONLY path through which a brand-new auth user is created in
 * this app — public signup is disabled. The action:
 *   1. Validates the invite token, expiry, and `accepted_at`.
 *   2. Creates a Supabase auth user via the admin client (bypasses the
 *      org-level `enable_signup=false` setting because invites are gated by
 *      a single-use token only the inviter could have provided).
 *   3. Signs that user in via password (so the cookie session is set).
 *   4. Calls acceptInviteWithToken to add the membership + warehouse
 *      assignment + audit log.
 */
export async function acceptInviteWithSignupAction(input: {
  token: string;
  password: string;
  fullName?: string;
}): Promise<ActionResult<{ organizationId: string }>> {
  const parsed = acceptInviteWithSignupSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err(
      'internal_error',
      'Server is missing SUPABASE_SERVICE_ROLE_KEY. Set it in Vercel env vars.',
    );
  }

  // 1. Validate the invite first so we never create an auth user we'll have
  //    to clean up later.
  const { data: invite, error: inviteErr } = await admin
    .from('organization_invites')
    .select('id, organization_id, email, accepted_at, expires_at')
    .eq('token', parsed.data.token)
    .maybeSingle();
  if (inviteErr) return err('internal_error', inviteErr.message);
  if (!invite) return err('not_found', 'Invite not found');
  if (invite.accepted_at) return err('conflict', 'Invite already accepted');
  if (new Date(invite.expires_at as string).getTime() < Date.now()) {
    return err('validation_error', 'Invite has expired');
  }

  const email = (invite.email as string).toLowerCase();

  // 2. Check if an auth user already exists for this email. If so, this is
  //    actually the "I have an account, sign me in" path — return a clear
  //    error directing them to the sign-in option.
  //
  //    The Supabase admin listUsers API in this SDK version does NOT support a
  //    server-side email filter (only `page` + `perPage`). We paginate at the
  //    max page size and short-circuit on the first match. Bounded by a hard
  //    cap so a runaway org can't hang this action.
  const MAX_PAGES = 100;
  const PER_PAGE = 1000;
  let alreadyExists = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error: listErr } = await admin.auth.admin.listUsers({
      page,
      perPage: PER_PAGE,
    });
    if (listErr) return err('internal_error', listErr.message);
    const users = data?.users ?? [];
    if (users.some((u) => u.email?.toLowerCase() === email)) {
      alreadyExists = true;
      break;
    }
    if (users.length < PER_PAGE) break;
  }
  if (alreadyExists) {
    return err(
      'conflict',
      'An account already exists for this email. Use the "I already have an account" option instead.',
    );
  }

  // 3. Create the auth user (admin path bypasses enable_signup=false).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: parsed.data.fullName ? { full_name: parsed.data.fullName } : {},
  });
  if (createErr || !created.user) {
    return err('internal_error', createErr?.message ?? 'Failed to create user');
  }

  // 4. Optionally create a user_profiles row matching the new auth user. The
  //    schema may already have a trigger that does this; the upsert is safe.
  await admin
    .from('user_profiles')
    .upsert(
      {
        id: created.user.id,
        email,
        full_name: parsed.data.fullName ?? null,
      },
      { onConflict: 'id' },
    );

  // 5. Sign the user in so subsequent server actions have a session cookie.
  const supabase = await createClient({ rememberSession: true });
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.password,
  });
  if (signInErr) return err('internal_error', signInErr.message);

  // 6. Accept the invite (creates membership + assignment + audits).
  try {
    const result = await acceptInviteWithToken(parsed.data.token, created.user.id);
    revalidatePath('/dashboard');
    return ok({ organizationId: result.organizationId });
  } catch (e) {
    return toResult(e);
  }
}

