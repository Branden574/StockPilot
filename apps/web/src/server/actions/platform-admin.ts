'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { hashPassphrase, verifyPassphrase } from '@/lib/auth/platform-passphrase';
import { sendEmail } from '@/lib/email/resend';
import { inviteEmailHtml, inviteEmailText } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { slugify } from '@/lib/utils';
import { recordPlatformAudit } from '@/server/services/platform/audit';

import { err, ok, type ActionResult } from '@stockpilot/core';

const createOrgForSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers, and dashes only')
    .optional(),
  timezone: z.string().min(1).max(64).default('America/Los_Angeles'),
  industry: z.string().trim().max(64).optional().nullable(),
  size: z.string().trim().max(32).optional().nullable(),
});

export type CreateOrgForInput = z.infer<typeof createOrgForSchema>;

/**
 * Platform-admin action — provision a brand-new tenant org for a customer
 * in one shot. Creates the Supabase auth user (which triggers a magic-link
 * invite email), creates the organization, makes the new user the owner,
 * sets it as their default org, and seeds a default warehouse so they
 * land directly on a usable dashboard on first sign-in (skipping
 * /onboarding because the org already exists).
 *
 * Gated by `checkPlatformAdmin({ requireStepUp: true })` — the VERIFIED auth
 * email (auth.getUser, NOT the user-writable profile column) checked against
 * the STOCKPILOT_PLATFORM_ADMIN_EMAILS env var allowlist, plus a fresh MFA
 * step-up. Non-admins get a generic `forbidden` result so the surface area of
 * the check isn't
 * leaked.
 */
export async function createOrgForCustomerAction(
  input: CreateOrgForInput,
): Promise<ActionResult<{ organizationId: string; slug: string; userId: string }>> {
  // Gated on the VERIFIED auth email + a fresh AAL2 step-up: provisioning
  // creates a real auth user + org via the service role, so it's as sensitive
  // as billing/act-as and gets the same step-up.
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to provision an organization.', {
          reason: 'aal2_required',
        })
      : err('forbidden', 'Not authorized.');
  }
  const session = gate.session;

  const parsed = createOrgForSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err(
      'internal_error',
      'Server is missing SUPABASE_SERVICE_ROLE_KEY. Check Vercel env config.',
    );
  }

  // 1. Invite the user. generateLink({type:'invite'}) creates the auth row
  //    and returns the magic link WITHOUT sending mail — we deliver it via
  //    the app's own Resend transport below. (inviteUserByEmail sends
  //    through Supabase's BUILT-IN mailer, which is capped at ~2 emails/hr
  //    project-wide — the same cap that silently broke password resets,
  //    see requestPasswordResetAction.)
  //
  //    If the email already has an auth account, we fail loudly rather
  //    than silently re-inviting — the operator should pick a different
  //    flow (e.g. inviting them to an existing org).
  const redirectTo = `${env.NEXT_PUBLIC_APP_URL}/dashboard`;
  const { data: invited, error: inviteErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: parsed.data.email,
    options: { redirectTo },
  });

  if (inviteErr || !invited?.user) {
    await reportError(inviteErr ?? new Error('invite_user_no_data'), {
      tag: 'platform-admin.invite',
      extra: { email: parsed.data.email },
    });
    const msg = inviteErr?.message ?? 'Failed to invite user';
    // Surface "already exists" cleanly so the operator knows to use a
    // different onboarding path; everything else is a generic internal.
    if (/registered|already|exist/i.test(msg)) {
      return err(
        'conflict',
        'An account already exists for this email. Use the regular member-invite flow on an existing org instead.',
      );
    }
    return err('internal_error', 'Failed to invite user.');
  }

  const newUserId = invited.user.id;

  // 2. Ensure the user_profiles row exists. There may be a trigger
  //    handling this already; upsert is the safe shape either way.
  await admin
    .from('user_profiles')
    .upsert({ id: newUserId, email: parsed.data.email }, { onConflict: 'id' });

  // 3. Pick a unique slug — same shape as the self-serve org create.
  const candidateSlug = parsed.data.slug?.length
    ? parsed.data.slug
    : slugify(parsed.data.name);
  const slug = await ensureUniqueSlug(candidateSlug, admin);

  // 4. Create the org. Admin client bypasses RLS — same pattern as
  //    createOrganizationAction in apps/web/src/server/actions/organization.ts.
  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .insert({
      name: parsed.data.name,
      slug,
      industry: parsed.data.industry ?? null,
      size: parsed.data.size ?? null,
      timezone: parsed.data.timezone,
      currency: 'USD',
    })
    .select('id, slug')
    .single();

  if (orgErr || !org) {
    await reportError(orgErr ?? new Error('org_insert_no_data'), {
      tag: 'platform-admin.org-insert',
      extra: { email: parsed.data.email, slug },
    });
    return err('internal_error', 'Failed to create organization.');
  }

  const orgId = org.id as string;
  const orgSlug = org.slug as string;

  // 5. Make the new user the owner. If this fails, roll back the org so
  //    the operator can retry cleanly (matches createOrganizationAction's
  //    behavior).
  const { error: memberErr } = await admin.from('organization_members').insert({
    organization_id: orgId,
    user_id: newUserId,
    role: 'owner',
    accepted_at: new Date().toISOString(),
  });
  if (memberErr) {
    await admin.from('organizations').delete().eq('id', orgId);
    await reportError(memberErr, {
      tag: 'platform-admin.member-insert',
      extra: { orgId, newUserId },
    });
    return err('internal_error', 'Failed to assign ownership; org rolled back.');
  }

  // 6. Set as the new user's default org. Skips /onboarding on first
  //    sign-in (middleware sees they have an org already and routes them
  //    to /dashboard).
  await admin
    .from('user_profiles')
    .update({ default_organization_id: orgId })
    .eq('id', newUserId);

  // 7. Seed a default location so they can add items immediately.
  await admin.from('locations').insert({
    organization_id: orgId,
    name: 'Main Warehouse',
    type: 'warehouse',
  });

  // 8. Audit log — write directly to audit_logs because the standard
  //    audit() helper assumes single-org context; this is a cross-org
  //    event (the actor is in their own org, the action targets a new
  //    org). Scope to the NEW org so it appears in that org's audit
  //    feed, with the platform admin as the recorded actor.
  try {
    await admin.from('audit_logs').insert({
      organization_id: orgId,
      user_id: session.userId,
      event: 'organization.provisioned_by_platform_admin',
      metadata: {
        entity_type: 'organization',
        entity_id: orgId,
        provisioned_for_email: parsed.data.email,
        provisioned_for_user_id: newUserId,
        platform_admin_email: session.email,
      },
    });
  } catch (e) {
    await reportError(e, { tag: 'platform-admin.audit', extra: { orgId } });
  }

  // 9. Deliver the sign-in link via the app's Resend transport (see step 1
  //    — generateLink minted the link but sent nothing). If the send fails,
  //    the org is still provisioned; surface the failure to the operator
  //    instead of rolling back.
  // Same /auth/confirm construction as the password-reset email: the raw
  // action_link returns the session in a URL fragment that the server-side
  // callback can't read, bouncing invitees to /signin.
  const inviteHashedToken = invited.properties?.hashed_token;
  const actionLink = inviteHashedToken
    // next=/reset/complete, NOT /dashboard: the invite creates a
    // PASSWORD-LESS auth user. Landing them on the dashboard leaves them
    // with no credential — once that session expires, their only way back
    // in is guessing to use "Forgot password". Force the set-a-password
    // form while the invite session is live.
    ? `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(inviteHashedToken)}&type=invite&next=${encodeURIComponent('/reset/complete')}`
    : invited.properties?.action_link;
  if (actionLink) {
    const sent = await sendEmail({
      to: parsed.data.email,
      subject: `Your ${parsed.data.name} workspace on StockPilot is ready`,
      html: inviteEmailHtml({
        organizationName: parsed.data.name,
        inviterName: 'The StockPilot team',
        acceptUrl: actionLink,
      }),
      text: inviteEmailText({
        organizationName: parsed.data.name,
        inviterName: 'The StockPilot team',
        acceptUrl: actionLink,
      }),
    });
    if (!sent.ok) {
      await reportError(new Error(sent.error ?? 'invite email send failed'), {
        tag: 'platform-admin.invite-email',
        extra: { orgId, email: parsed.data.email },
      });
      return err(
        'internal_error',
        'Org created, but the invite email failed to send. Re-send it manually or check Resend.',
      );
    }
  }

  revalidatePath('/dashboard/admin/orgs');
  return ok({ organizationId: orgId, slug: orgSlug, userId: newUserId });
}

async function ensureUniqueSlug(
  base: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string> {
  let candidate = base || `org-${Date.now()}`;
  let suffix = 0;
  while (true) {
    const { data } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
    if (suffix > 50) {
      return `${base}-${Math.random().toString(36).slice(2, 7)}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Org-deletion passphrase + passphrase-gated hard delete
// ─────────────────────────────────────────────────────────────────────────────

const setPassphraseSchema = z.object({
  passphrase: z.string().min(12).max(200),
  /** Required to ROTATE an existing passphrase (ignored on the first-ever set). */
  currentPassphrase: z.string().max(200).optional(),
});

/**
 * Set/rotate the platform org-deletion passphrase. A SECOND factor beyond the
 * platform-admin allowlist + AAL2: no org can be hard-deleted without it. Stored
 * as a scrypt hash — never retrievable. Gated by a fresh MFA step-up.
 *
 * CRITICAL: rotating an existing passphrase REQUIRES the current one. Without
 * that, a compromised platform-admin session could simply overwrite the
 * passphrase with a known value and then delete — defeating the whole point of
 * the second factor. The first-ever set (bootstrap, no passphrase yet) is open.
 */
export async function setOrgDeletionPassphraseAction(
  input: z.input<typeof setPassphraseSchema>,
): Promise<ActionResult<void>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to set the deletion passphrase.', {
          reason: 'aal2_required',
        })
      : err('forbidden', 'Not authorized.');
  }
  const parsed = setPassphraseSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Passphrase must be at least 12 characters.');
  }
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err('internal_error', 'Server is missing SUPABASE_SERVICE_ROLE_KEY.');
  }
  // If a passphrase already exists, the caller must prove they know it before
  // rotating it — a stolen session cannot silently swap it out.
  const { data: existing } = await admin
    .from('platform_settings')
    .select('org_deletion_passphrase_hash, org_deletion_passphrase_salt')
    .eq('id', true)
    .maybeSingle();
  const cur = existing as
    | { org_deletion_passphrase_hash: string | null; org_deletion_passphrase_salt: string | null }
    | null;
  if (cur?.org_deletion_passphrase_hash && cur?.org_deletion_passphrase_salt) {
    if (
      !verifyPassphrase(
        parsed.data.currentPassphrase ?? '',
        cur.org_deletion_passphrase_hash,
        cur.org_deletion_passphrase_salt,
      )
    ) {
      return err('forbidden', 'Enter the current deletion passphrase to change it.');
    }
  }
  const { hash, salt } = hashPassphrase(parsed.data.passphrase);
  const { error } = await admin.from('platform_settings').upsert({
    id: true,
    org_deletion_passphrase_hash: hash,
    org_deletion_passphrase_salt: salt,
    updated_at: new Date().toISOString(),
    updated_by: gate.session.userId,
  });
  if (error) return err('internal_error', 'Could not save the passphrase.');
  await recordPlatformAudit({
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
    action: 'deletion_passphrase_set',
  });
  return ok(undefined);
}

const removeOrgSchema = z.object({
  orgId: z.string().uuid(),
  passphrase: z.string().min(1).max(200),
  /** The operator must retype the org's exact name — a second, human confirm. */
  confirmName: z.string().min(1).max(200),
  /** Also delete members whose ONLY org is this one (onboarding-mistake accounts). */
  alsoDeleteOrphanedUsers: z.boolean().optional(),
});

/**
 * Hard-delete an organization (cascade). Requires: platform-admin + fresh AAL2,
 * the correct deletion passphrase (scrypt-verified, rate-limited), AND the
 * operator re-typing the org's exact name. Audited. Irreversible.
 */
export async function removeOrgAction(
  input: z.input<typeof removeOrgSchema>,
): Promise<ActionResult<{ deletedUsers: number }>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to remove an organization.', {
          reason: 'aal2_required',
        })
      : err('forbidden', 'Not authorized.');
  }
  const parsed = removeOrgSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input.');

  // Brute-force guard on the passphrase — 5 attempts/min per admin. FAIL CLOSED:
  // on this irreversible action a rate-limiter error must block, not wave through.
  const rl = await checkRateLimit(`org-delete:${gate.session.userId}`, 5, 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts — wait a minute and try again.');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err('internal_error', 'Server is missing SUPABASE_SERVICE_ROLE_KEY.');
  }

  // 1. A passphrase must be configured, and it must match.
  const { data: settings } = await admin
    .from('platform_settings')
    .select('org_deletion_passphrase_hash, org_deletion_passphrase_salt')
    .eq('id', true)
    .maybeSingle();
  const s = settings as
    | { org_deletion_passphrase_hash: string | null; org_deletion_passphrase_salt: string | null }
    | null;
  if (!s?.org_deletion_passphrase_hash || !s?.org_deletion_passphrase_salt) {
    return err(
      'validation_error',
      'Set an org-deletion passphrase (Platform → Settings) before removing any organization.',
    );
  }
  if (
    !verifyPassphrase(parsed.data.passphrase, s.org_deletion_passphrase_hash, s.org_deletion_passphrase_salt)
  ) {
    return err('forbidden', 'Incorrect deletion passphrase.');
  }

  // 2. Load the org + require an exact name re-type.
  const { data: org } = await admin
    .from('organizations')
    .select('id, name, slug')
    .eq('id', parsed.data.orgId)
    .maybeSingle();
  const o = org as { id: string; name: string; slug: string } | null;
  if (!o) return err('not_found', 'Organization not found.');
  if (o.name !== parsed.data.confirmName.trim()) {
    return err('validation_error', 'The typed organization name does not match.');
  }

  // 3. Collect members whose ONLY membership is this org BEFORE the cascade
  //    removes the membership rows (so we can optionally delete those orphan
  //    accounts — the common "created under the wrong email" case).
  const orphanUserIds: string[] = [];
  if (parsed.data.alsoDeleteOrphanedUsers) {
    const { data: members } = await admin
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', parsed.data.orgId);
    for (const m of (members ?? []) as Array<{ user_id: string }>) {
      // NEVER delete the acting admin's own account, even if they happen to be
      // the sole member of a throwaway org.
      if (m.user_id === gate.session.userId) continue;
      const { count } = await admin
        .from('organization_members')
        .select('organization_id', { count: 'exact', head: true })
        .eq('user_id', m.user_id)
        .neq('organization_id', parsed.data.orgId);
      if ((count ?? 0) === 0) orphanUserIds.push(m.user_id);
    }
  }

  // 4. Hard delete the org (FK cascades its data + memberships).
  const { error: delErr } = await admin.from('organizations').delete().eq('id', parsed.data.orgId);
  if (delErr) return err('internal_error', 'Could not delete the organization.');

  // 5. Delete the now-orphaned accounts (best-effort; failure doesn't undo the
  //    org delete, which already succeeded). RE-VERIFY zero memberships right
  //    before each delete: the org cascade has already removed this org's
  //    membership rows, so any remaining row means the user was added to another
  //    org after our pre-delete snapshot — close that TOCTOU race and skip them.
  let deletedUsers = 0;
  for (const uid of orphanUserIds) {
    try {
      const { count } = await admin
        .from('organization_members')
        .select('organization_id', { count: 'exact', head: true })
        .eq('user_id', uid);
      if ((count ?? 0) > 0) continue; // gained another org in the meantime — keep
      await admin.auth.admin.deleteUser(uid);
      deletedUsers += 1;
    } catch (e) {
      await reportError(e, { tag: 'platform-admin.orphan-user-delete', extra: { uid } });
    }
  }

  await recordPlatformAudit({
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
    action: 'org_deleted',
    targetOrganizationId: null, // the org row is gone; keep name/slug in detail
    detail: { orgId: o.id, name: o.name, slug: o.slug, deletedOrphanUsers: deletedUsers },
  });
  revalidatePath('/platform');
  return ok({ deletedUsers });
}
