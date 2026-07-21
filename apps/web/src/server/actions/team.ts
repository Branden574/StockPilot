'use server';

import { revalidatePath } from 'next/cache';

import {
  assertCurrentAal2,
  assertPermission,
  ServiceError,
  withContext,
} from '@/server/services/context';
import { audit } from '@/server/services/audit';
import { TeamService, acceptInviteWithToken } from '@/server/services/team';
import { sendPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { requireSession } from '@/lib/auth/session';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import {
  acceptInviteSchema,
  err,
  inviteMemberSchema,
  ok,
  setMemberChartersSchema,
  setMemberWarehouseAccessSchema,
  updateMemberRoleSchema,
  type AcceptInviteInput,
  type ActionResult,
  type InviteMemberInput,
  type Role,
  type SetMemberChartersInput,
  type SetMemberWarehouseAccessInput,
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
  // Note: `inviteMemberSchema.role` is restricted to INVITEABLE_ROLES, so
  // `parsed.data.role` cannot be 'owner'. The schema is the single source
  // of truth — owner is only reassigned via the ownership-transfer flow.

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
      charterIds: parsed.data.charterIds,
      warehouseId: parsed.data.warehouseId ?? null,
      allWarehouses: parsed.data.allWarehouses ?? false,
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

const setMemberDriverSchema = z.object({
  memberId: z.string().uuid(),
  isDriver: z.boolean(),
});

/** Mark/unmark a member as a delivery driver (drives the Assign-delivery picker). */
export async function setMemberDriverAction(
  input: z.infer<typeof setMemberDriverSchema>,
): Promise<ActionResult<void>> {
  const parsed = setMemberDriverSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.setDeliveryDriver(parsed.data.memberId, parsed.data.isDriver);
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

const sendMemberPasswordResetSchema = z.object({ targetUserId: z.string().uuid() });

/**
 * Org-admin action: email an accepted member a password-reset link.
 *
 * Gated on `members:invite` (admin+) — the same permission the invite /
 * resend-invite flows use for "send this member an account email". The
 * target is resolved STRICTLY from the caller's org membership: we never
 * accept a raw email from the client, because a recovery link is an
 * account-takeover primitive — org membership is the security boundary.
 *
 * Rate limit shares the self-serve key family (`pwreset-req:<email>`,
 * 3/15min, closed) so an admin can't blast a user past the budget the
 * public forgot-password form already enforces. Unlike the public form
 * there is NO anti-enumeration theater here — the admin already knows the
 * member exists, so rate-limit and send failures are surfaced verbatim.
 */
export async function sendMemberPasswordResetAction(
  targetUserId: string,
): Promise<ActionResult<{ email: string }>> {
  const parsed = sendMemberPasswordResetSchema.safeParse({ targetUserId });
  if (!parsed.success) return err('validation_error', 'Invalid user id');
  try {
    const ctx = await withContext();
    assertPermission(ctx, 'members:invite');

    const { data: member, error: memberErr } = await ctx.supabase
      .from('organization_members')
      .select('user_id, accepted_at')
      .eq('organization_id', ctx.organizationId)
      .eq('user_id', parsed.data.targetUserId)
      .maybeSingle();
    if (memberErr) return err('internal_error', memberErr.message);
    if (!member) return err('not_found', 'Member not found in this organization.');
    if (!member.accepted_at) {
      return err(
        'validation_error',
        'This member has not accepted their invite yet — resend the invite instead.',
      );
    }

    const { data: profile, error: profileErr } = await ctx.supabase
      .from('user_profiles')
      .select('email')
      .eq('id', parsed.data.targetUserId)
      .maybeSingle();
    if (profileErr) return err('internal_error', profileErr.message);
    const email = (profile?.email as string | null | undefined) ?? null;
    if (!email) return err('validation_error', 'That member has no email on file.');

    const rl = await checkRateLimit(
      `pwreset-req:${email.toLowerCase()}`,
      3,
      15 * 60_000,
      'closed',
    );
    if (!rl.allowed) {
      return err(
        'rate_limited',
        'Too many reset emails for this member. Try again in 15 minutes.',
      );
    }

    const sent = await sendPasswordResetEmail(email);
    if (!sent) return err('internal_error', 'Email failed to send — check Resend.');

    await audit(
      {
        event: 'member.password_reset_sent',
        entityType: 'user',
        entityId: parsed.data.targetUserId,
        extra: { email },
      },
      ctx,
    );

    return ok({ email });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Replaces the set of charters an existing member oversees for one
 * warehouse. Empty `charterIds` = "all charters" (a single null-charter
 * assignment row). Gated inside the service on `members:invite` (admin+).
 */
export async function setMemberChartersAction(
  input: SetMemberChartersInput,
): Promise<ActionResult<void>> {
  const parsed = setMemberChartersSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.setMemberCharterAssignments({
      userId: parsed.data.userId,
      warehouseId: parsed.data.warehouseId,
      charterIds: parsed.data.charterIds,
    });
    revalidatePath('/dashboard/team');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Sets an existing member's warehouse access: all warehouses (flag + one
 * assignment row per current warehouse; the 0280 trigger covers future
 * ones) or exactly one warehouse (rows reconciled to it — assignments at
 * other warehouses, including charter scoping there, are removed by
 * design). Gated inside the service on `members:invite` (admin+).
 */
export async function setMemberWarehouseAccessAction(
  input: SetMemberWarehouseAccessInput,
): Promise<ActionResult<void>> {
  const parsed = setMemberWarehouseAccessSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await TeamService.forCurrentUser();
    await svc.setMemberWarehouseAccess({
      userId: parsed.data.userId,
      allWarehouses: parsed.data.allWarehouses,
      warehouseId: parsed.data.warehouseId ?? null,
    });
    revalidatePath('/dashboard/team');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const transferOwnershipSchema = z.object({
  targetMemberId: z.string().uuid('Invalid member id'),
  password: z.string().min(1, 'Confirm your password').max(128),
});

/**
 * Transfers organization ownership from the calling user to another
 * active member. This is the ONLY supported path to change the owner
 * — the DB role-guard trigger blocks every other route (direct UPDATE
 * from an admin or even a non-bypassing definer function).
 *
 * Defense-in-depth gates the action layer enforces BEFORE the swap:
 *   1. Caller must currently hold the `owner` role in the request's org.
 *   2. Caller's session MUST satisfy AAL2 (proven MFA this session) if
 *      they have any verified MFA factor. Stripping/handing off the
 *      owner role is among the most-destructive admin mutations.
 *   3. Caller must re-confirm their password out-of-band. Even with a
 *      stolen AAL2 cookie an attacker doesn't know the password.
 *   4. Rate-limited (5 attempts / 15min, closed mode) so a leaked
 *      cookie can't brute-force the password gate.
 *   5. Target must be an accepted member of the same org and NOT the
 *      caller (the DB function also enforces this — belt + braces).
 *
 * The actual swap runs in a SECURITY DEFINER RPC so it's atomic and
 * bypasses the role-guard trigger via the service-role branch.
 */
export async function transferOwnershipAction(input: {
  targetMemberId: string;
  password: string;
}): Promise<ActionResult<{ newOwnerUserId: string }>> {
  const parsed = transferOwnershipSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  try {
    const ctx = await withContext();
    if (ctx.role !== 'owner') {
      return err('forbidden', 'Only the current owner can transfer ownership.');
    }

    const session = await requireSession();

    // Rate-limit BEFORE the password verify so a leaked cookie can't
    // brute-force the password.
    const rl = await checkRateLimit(
      `owner-transfer:${session.userId}`,
      5,
      15 * 60_000,
      'closed',
    );
    if (!rl.allowed) {
      return err(
        'rate_limited',
        'Too many ownership-transfer attempts. Try again in a few minutes.',
      );
    }

    // AAL2 step-up. If caller has any verified factor, they must have
    // completed the MFA challenge this session.
    const { data: factorsData } = await ctx.supabase.auth.mfa.listFactors();
    const hasVerifiedFactor = (factorsData?.totp ?? []).some(
      (f) => f.status === 'verified',
    );
    if (hasVerifiedFactor) {
      await assertCurrentAal2(ctx);
    }

    // Password re-confirm.
    const pwRes = await verifyPasswordSideChannel(session.email, parsed.data.password);
    if (!pwRes.ok) {
      return err(
        pwRes.reason === 'invalid_password' ? 'forbidden' : 'internal_error',
        pwRes.message,
      );
    }

    // Look up the target member, sanity-check before invoking the RPC
    // (gives a friendlier error than a raw 'invalid_parameter_value'
    // from Postgres).
    const admin = createAdminClient();
    const { data: target, error: targetErr } = await admin
      .from('organization_members')
      .select('id, user_id, role, accepted_at')
      .eq('organization_id', ctx.organizationId)
      .eq('id', parsed.data.targetMemberId)
      .maybeSingle();
    if (targetErr) return err('internal_error', targetErr.message);
    if (!target) return err('not_found', 'Target member not found in this organization.');
    if ((target.user_id as string) === ctx.userId) {
      return err('validation_error', 'You cannot transfer ownership to yourself.');
    }
    if (!target.accepted_at) {
      return err(
        'validation_error',
        'Target has not accepted their invite yet. Wait until they finish onboarding.',
      );
    }
    if ((target.role as string) === 'owner') {
      return err('validation_error', 'That member is already the owner.');
    }

    const { error: rpcErr } = await admin.rpc('transfer_org_ownership', {
      p_organization_id: ctx.organizationId,
      p_caller_user_id: ctx.userId,
      p_target_user_id: target.user_id as string,
    });
    if (rpcErr) return err('internal_error', rpcErr.message);

    await audit(
      {
        event: 'organization.ownership.transferred',
        entityType: 'organization',
        entityId: ctx.organizationId,
        before: { owner_user_id: ctx.userId },
        after: { owner_user_id: target.user_id as string },
        extra: { previous_owner_member_id: target.id as string },
      },
      ctx,
    );

    revalidatePath('/dashboard/team');
    revalidatePath('/dashboard');
    return ok({ newOwnerUserId: target.user_id as string });
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
  //    Implemented via the SECURITY DEFINER function
  //    `public.auth_user_exists_by_email` (migration 0097), which does a single
  //    indexed lookup against `auth.users`. Replaces the previous O(n) paginated
  //    `listUsers` loop that scanned up to 100k users per invite acceptance.
  const { data: existsData, error: existsErr } = await admin.rpc(
    'auth_user_exists_by_email',
    { p_email: email },
  );
  if (existsErr) return err('internal_error', existsErr.message);
  const alreadyExists = existsData === true;
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

