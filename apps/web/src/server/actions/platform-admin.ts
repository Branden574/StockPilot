'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { sendEmail } from '@/lib/email/resend';
import { inviteEmailHtml, inviteEmailText } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { slugify } from '@/lib/utils';

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
  const actionLink = invited.properties?.action_link;
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
