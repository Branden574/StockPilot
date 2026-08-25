import 'server-only';

import { createHash } from 'node:crypto';

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import {
  renderEmailChangeCurrentEmail,
  renderEmailChangeNewEmail,
  renderEmailChangedNoticeEmail,
} from '@/lib/email/es/families/security';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { ServiceError } from '@/server/services/context';

import type { AuditEvent } from '@/server/services/audit';

/**
 * VERIFIED SELF-SERVICE EMAIL CHANGE — the one module that changes a user's
 * account identity. Design record: docs/superpowers/specs/
 * 2026-08-25-verified-email-change-design.md.
 *
 * ═══ WHO IS THE SOURCE OF TRUTH ═══
 *
 * Supabase Auth (auth.users.email) is the identity. user_profiles.email is a
 * projection the DATABASE keeps equal to it: migration 0345 rewrote the 0177
 * pin so the projection accepts exactly one value — the verified auth email —
 * and added an AFTER UPDATE OF email trigger on auth.users that writes the
 * projection and the `user.email.changed` audit row in the same transaction
 * as GoTrue's own update. Nothing in this file can produce a split identity;
 * reconcileProfileEmail() below is the idempotent repair for the case where
 * that trigger was somehow not there.
 *
 * ═══ WHY THE LINKS ARE MINTED HERE AND NOT BY supabase.auth.updateUser ═══
 *
 * updateUser({ email }) sends its confirmation through GoTrue's built-in
 * mailer. Production has no custom SMTP and `rate_limit_email_sent = 2` per
 * HOUR, project-wide (read from the Management API 2026-08-25); the 2026-07-02
 * incident recorded that mailer 429-ing silently behind a success response.
 * Secure email change needs TWO messages per request. So, exactly as password
 * reset does, the links are minted with admin.generateLink and delivered by
 * Resend to our own /auth/confirm route.
 *
 * ═══ THE GOTRUE BUG THIS FILE WORKS AROUND (measured, not inferred) ═══
 *
 * Production has `mailer_secure_email_change_enabled = true`: both the
 * current and the new address must confirm. generateLink({ type:
 * 'email_change_current' }) returns the correct hashed token. generateLink({
 * type: 'email_change_new' }) returns sha224(CURRENT_email + otp) but STORES
 * sha224(NEW_email + otp) — verified against auth.users on 2026-08-25 (probe
 * user ed7d36b5…: stored 1fb479…, returned 8eed06…). A link built from the
 * returned value can never verify. The new-side hash is therefore computed
 * here from the `email_otp` the same call returns; the stored and computed
 * values were confirmed byte-identical and the resulting link verifies.
 *
 * ═══ WHAT "PENDING" MEANS ═══
 *
 * Pending state lives in GoTrue only (user.new_email, email_change_sent_at).
 * Until BOTH links are used, auth.users.email, the projection, every
 * notification and every sign-in keep the current address. The unverified
 * address receives exactly one thing: its own confirmation link.
 */

/** Production `mailer_otp_exp` is 3600s. */
export const EMAIL_CHANGE_LINK_TTL_MS = 60 * 60 * 1000;
/** Where the completing confirmation lands. Hard-coded — never from a query. */
export const EMAIL_CHANGE_RETURN_PATH = '/dashboard/settings/profile';

export interface EmailChangeStatus {
  /** The verified, canonical sign-in email right now. */
  email: string;
  /** Address awaiting confirmation, or null when nothing is pending. */
  pendingEmail: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  /** True when a pending change's links have aged out (resend to continue). */
  expired: boolean;
}

/**
 * What the caller already knows about the session's MFA posture. Resolved by
 * the caller because the two callers learn it differently: the web action
 * from the cookie session (listFactors + getAuthenticatorAssuranceLevel), the
 * Bearer route from the verified token's `aal` claim via withApiContext.
 */
export interface MfaPosture {
  /** The user has at least one VERIFIED TOTP factor. */
  enrolled: boolean;
  /** The calling session is currently at AAL2. */
  aal2: boolean;
}

/**
 * ServiceError has no 'rate_limited' code; callers map
 * `details.reason === 'rate_limited'` to the ActionResult code / HTTP 429.
 */
function rateLimited(message: string): ServiceError {
  return new ServiceError('forbidden', message, { reason: 'rate_limited' });
}

function sha224Hex(input: string): string {
  return createHash('sha224').update(input).digest('hex');
}

function isoPlus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** The /auth/confirm URL for an email-change token. `next` is deliberately
 *  absent: the route hard-codes its destination for this type. */
export function emailChangeConfirmUrl(tokenHash: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=email_change`;
}

async function loadAuthUser(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new ServiceError('not_found', 'Account not found.');
  }
  return data.user;
}

/**
 * The verified account email for a user id — the value every user-targeted
 * sender should resolve at SEND time rather than carry around as a string.
 */
export async function resolveUserEmail(userId: string): Promise<string | null> {
  const user = await loadAuthUser(userId);
  return user.email ?? null;
}

interface ProfileGuard {
  organizationId: string | null;
  firstName: string | null;
}

/**
 * Refuses tombstoned and disabled accounts. The callers already run their own
 * account-status funnel (loadAccountStatus / withApiContext); this is the
 * defence-in-depth copy that also covers `deleted_at`, which those do not
 * read, and it is what stands between a disabled session and GoTrue.
 */
async function loadProfileGuard(userId: string): Promise<ProfileGuard> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_profiles')
    .select('default_organization_id, full_name, disabled_at, deleted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new ServiceError('internal_error', 'Could not verify your account status. Please try again.');
  }
  if (!data) throw new ServiceError('not_found', 'Account not found.');
  if (data.deleted_at) throw new ServiceError('forbidden', 'This account has been deleted.');
  if (data.disabled_at) throw new ServiceError('forbidden', 'This account has been disabled.');
  const fullName = (data.full_name as string | null)?.trim() ?? '';
  return {
    organizationId: (data.default_organization_id as string | null) ?? null,
    firstName: fullName ? fullName.split(/\s+/)[0]! : null,
  };
}

async function writeAudit(
  event: AuditEvent,
  userId: string,
  organizationId: string | null,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      organization_id: organizationId,
      user_id: userId,
      event,
      metadata: {
        entity_type: 'user',
        entity_id: userId,
        warehouse_id: null,
        before: null,
        after: null,
        reason: null,
        ...extra,
      },
    });
  } catch (e) {
    void reportError(e, { tag: 'audit.email_change_emit_failed', level: 'warning', extra: { event } });
  }
}

export interface MintedEmailChangeLinks {
  currentUrl: string;
  newUrl: string;
  sentAt: string;
}

/**
 * Mints both one-time links. Exported for tests: the new-side hash MUST be
 * sha224(newEmail + otp), never the value generateLink returns (see header).
 */
export async function mintEmailChangeLinks(
  currentEmail: string,
  newEmail: string,
): Promise<MintedEmailChangeLinks> {
  const admin = createAdminClient();

  const current = await admin.auth.admin.generateLink({
    type: 'email_change_current',
    email: currentEmail,
    newEmail,
  });
  const currentHash = current.data?.properties?.hashed_token;
  if (current.error || !currentHash) {
    throw new ServiceError('internal_error', current.error?.message ?? 'generateLink(email_change_current) returned no token');
  }

  const next = await admin.auth.admin.generateLink({
    type: 'email_change_new',
    email: currentEmail,
    newEmail,
  });
  const otp = next.data?.properties?.email_otp;
  if (next.error || !otp) {
    throw new ServiceError('internal_error', next.error?.message ?? 'generateLink(email_change_new) returned no otp');
  }
  // GoTrue stores sha224(NEW_email + otp) for the new side but returns the
  // hash computed with the CURRENT email. Compute the stored value ourselves.
  const newHash = sha224Hex(`${newEmail}${otp}`);

  return {
    currentUrl: emailChangeConfirmUrl(currentHash),
    newUrl: emailChangeConfirmUrl(newHash),
    sentAt: new Date().toISOString(),
  };
}

async function deliverEmailChangeLinks(args: {
  currentEmail: string;
  newEmail: string;
  links: MintedEmailChangeLinks;
  firstName: string | null;
}): Promise<void> {
  const requestedAt =
    new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) +
    ' UTC';
  const appUrl = env.NEXT_PUBLIC_APP_URL;

  const toNew = renderEmailChangeNewEmail({
    newEmail: args.newEmail,
    currentEmail: args.currentEmail,
    confirmUrl: args.links.newUrl,
    firstName: args.firstName,
    appUrl,
  });
  const toCurrent = renderEmailChangeCurrentEmail({
    currentEmail: args.currentEmail,
    newEmail: args.newEmail,
    approveUrl: args.links.currentUrl,
    firstName: args.firstName,
    requestedAt,
    appUrl,
  });

  // The NEW address gets ONLY its own confirmation. The CURRENT address gets
  // the approval request — the message that lets the real owner stop a
  // change they did not make.
  const [sentNew, sentCurrent] = await Promise.all([
    sendEmail({ to: args.newEmail, subject: toNew.subject, html: toNew.html, text: toNew.text, from: toNew.from }),
    sendEmail({
      to: args.currentEmail,
      subject: toCurrent.subject,
      html: toCurrent.html,
      text: toCurrent.text,
      from: toCurrent.from,
    }),
  ]);
  if (!sentNew.ok || !sentCurrent.ok) {
    throw new ServiceError(
      'internal_error',
      'Could not send the verification email. Please try again in a moment.',
    );
  }
}

/** Current state, read from GoTrue (the only place pending state lives). */
export async function getEmailChangeStatus(userId: string): Promise<EmailChangeStatus> {
  const user = await loadAuthUser(userId);
  const pendingEmail = user.new_email?.trim() ? user.new_email : null;
  const sentAt = pendingEmail ? (user.email_change_sent_at ?? null) : null;
  const expiresAt = sentAt ? isoPlus(sentAt, EMAIL_CHANGE_LINK_TTL_MS) : null;
  return {
    email: user.email ?? '',
    pendingEmail,
    sentAt,
    expiresAt,
    expired: expiresAt ? Date.now() > new Date(expiresAt).getTime() : false,
  };
}

export interface RequestEmailChangeArgs {
  userId: string;
  newEmail: string;
  currentPassword: string;
  mfa: MfaPosture;
  source: 'web' | 'mobile';
}

export interface RequestEmailChangeResult {
  pendingEmail: string;
  sentAt: string;
  expiresAt: string;
}

/**
 * Starts a change. Order of refusals matters and is tested:
 *   account status → same-address no-op → rate limits (user AND target, closed)
 *   → MFA step-up when enrolled → current password (side-channel) → duplicate
 *   → mint → deliver → audit.
 * Rate limits come BEFORE the password check so this endpoint cannot be used
 * as a password oracle; the AAL check comes before it so an enrolled user is
 * asked to step up without spending a GoTrue sign-in.
 */
export async function requestEmailChange(args: RequestEmailChangeArgs): Promise<RequestEmailChangeResult> {
  const guard = await loadProfileGuard(args.userId);
  const user = await loadAuthUser(args.userId);
  const currentEmail = user.email;
  if (!currentEmail) throw new ServiceError('internal_error', 'This account has no sign-in email.');

  const newEmail = args.newEmail.trim().toLowerCase();
  if (newEmail === currentEmail.toLowerCase()) {
    throw new ServiceError('validation_error', 'That is already your sign-in email.');
  }

  const [rlUser, rlTarget] = await Promise.all([
    checkRateLimit(`emailchange:${args.userId}`, 3, 15 * 60_000, 'closed'),
    checkRateLimit(`emailchange-target:${newEmail}`, 3, 15 * 60_000, 'closed'),
  ]);
  if (!rlUser.allowed || !rlTarget.allowed) {
    throw rateLimited('Too many email-change requests. Try again in a few minutes.');
  }

  if (args.mfa.enrolled && !args.mfa.aal2) {
    throw new ServiceError('forbidden', 'Re-authenticate with MFA before changing your email.', {
      reason: 'aal2_required',
    });
  }

  const pw = await verifyPasswordSideChannel(currentEmail, args.currentPassword);
  if (!pw.ok) {
    throw new ServiceError(
      'forbidden',
      pw.reason === 'invalid_password' ? 'Current password is incorrect.' : pw.message,
    );
  }

  // Duplicate target. GoTrue would refuse at mint time with a message that
  // names the collision; check first so the caller sees one generic sentence.
  const admin = createAdminClient();
  const { data: exists, error: existsError } = await admin.rpc('auth_user_exists_by_email', {
    p_email: newEmail,
  });
  if (existsError) {
    throw new ServiceError('internal_error', existsError.message);
  }
  if (exists === true) {
    throw new ServiceError('conflict', 'This email address cannot be used.');
  }

  const links = await mintEmailChangeLinks(currentEmail, newEmail);
  await deliverEmailChangeLinks({ currentEmail, newEmail, links, firstName: guard.firstName });

  await writeAudit('user.email.change_requested', args.userId, guard.organizationId, {
    from: currentEmail,
    to: newEmail,
    source: args.source,
  });

  return { pendingEmail: newEmail, sentAt: links.sentAt, expiresAt: isoPlus(links.sentAt, EMAIL_CHANGE_LINK_TTL_MS) };
}

/**
 * Re-mints and re-sends both links for the address already pending in
 * GoTrue. The target comes from GoTrue's own state, never from the caller,
 * so a resend can never redirect the change. Previous links stop working.
 */
export async function resendEmailChange(args: {
  userId: string;
  mfa: MfaPosture;
  source: 'web' | 'mobile';
}): Promise<{ pendingEmail: string; sentAt: string; expiresAt: string }> {
  const guard = await loadProfileGuard(args.userId);
  const user = await loadAuthUser(args.userId);
  const pending = user.new_email?.trim() ? user.new_email : null;
  if (!user.email || !pending) {
    throw new ServiceError('not_found', 'No email change is pending.');
  }

  const rl = await checkRateLimit(`emailchange-resend:${args.userId}`, 3, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    throw rateLimited('Too many resend requests. Try again in a few minutes.');
  }
  if (args.mfa.enrolled && !args.mfa.aal2) {
    throw new ServiceError('forbidden', 'Re-authenticate with MFA before resending.', {
      reason: 'aal2_required',
    });
  }

  const links = await mintEmailChangeLinks(user.email, pending);
  await deliverEmailChangeLinks({ currentEmail: user.email, newEmail: pending, links, firstName: guard.firstName });
  await writeAudit('user.email.change_resent', args.userId, guard.organizationId, {
    from: user.email,
    to: pending,
    source: args.source,
  });
  return { pendingEmail: pending, sentAt: links.sentAt, expiresAt: isoPlus(links.sentAt, EMAIL_CHANGE_LINK_TTL_MS) };
}

/**
 * Abandons a pending change. GoTrue exposes no cancel, so this goes through
 * `cancel_pending_email_change(uuid)` (mig 0345) — service_role only, and it
 * can only clear pending state; it cannot set an email.
 */
export async function cancelEmailChange(args: {
  userId: string;
  source: 'web' | 'mobile';
}): Promise<{ cancelled: boolean }> {
  const guard = await loadProfileGuard(args.userId);
  const user = await loadAuthUser(args.userId);
  const pending = user.new_email?.trim() ? user.new_email : null;
  if (!pending) throw new ServiceError('not_found', 'No email change is pending.');

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('cancel_pending_email_change', { p_user_id: args.userId });
  if (error) {
    throw new ServiceError('internal_error', error.message);
  }
  await writeAudit('user.email.change_cancelled', args.userId, guard.organizationId, {
    from: user.email ?? null,
    to: pending,
    source: args.source,
  });
  return { cancelled: data === true };
}

/**
 * IDEMPOTENT repair of the projection: if user_profiles.email differs from
 * the verified auth email, write the auth value (the 0345 pin permits exactly
 * this value) and audit it. Equal → no write, no audit row. Running it five
 * times leaves one result.
 */
export async function reconcileProfileEmail(
  userId: string,
): Promise<{ changed: boolean; email: string | null; previous: string | null }> {
  const user = await loadAuthUser(userId);
  const authEmail = user.email ?? null;
  if (!authEmail) return { changed: false, email: null, previous: null };

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from('user_profiles')
    .select('email, default_organization_id')
    .eq('id', userId)
    .maybeSingle();
  if (error || !profile) return { changed: false, email: authEmail, previous: null };

  const current = (profile.email as string | null) ?? null;
  if (current && current.toLowerCase() === authEmail.toLowerCase()) {
    return { changed: false, email: authEmail, previous: current };
  }

  const { error: updateError } = await admin
    .from('user_profiles')
    .update({ email: authEmail })
    .eq('id', userId);
  if (updateError) {
    void reportError(updateError, { tag: 'email_change.reconcile_failed', level: 'warning' });
    return { changed: false, email: authEmail, previous: current };
  }
  await writeAudit('user.email.changed', userId, (profile.default_organization_id as string | null) ?? null, {
    before: current,
    after: authEmail,
    source: 'reconcile',
  });
  return { changed: true, email: authEmail, previous: current };
}

/**
 * Runs once, from /auth/confirm, when the SECOND confirmation applied the
 * change. Repairs the projection (normally a no-op — the DB trigger already
 * did it) and tells the OLD address what happened. The old address is read
 * back from the audit row the trigger wrote, because by the time this runs
 * neither GoTrue nor the profile remembers it.
 */
export async function completeEmailChange(args: {
  userId: string;
}): Promise<{ email: string | null; notifiedPreviousEmail: string | null }> {
  const reconciled = await reconcileProfileEmail(args.userId);
  const email = reconciled.email;
  if (!email) return { email: null, notifiedPreviousEmail: null };

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from('audit_logs')
    .select('metadata, created_at')
    .eq('user_id', args.userId)
    .eq('event', 'user.email.changed')
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = rows?.[0] as { metadata: Record<string, unknown> | null; created_at: string } | undefined;
  const previous = (latest?.metadata?.before as string | undefined) ?? reconciled.previous ?? null;
  // Only a change that just happened earns a notice; a stale row (e.g. an
  // old change surfaced by a later reconcile) must not re-alarm anyone.
  const fresh = latest ? Date.now() - new Date(latest.created_at).getTime() < 10 * 60_000 : false;
  if (!previous || !fresh || previous.toLowerCase() === email.toLowerCase()) {
    return { email, notifiedPreviousEmail: null };
  }

  const { data: profile } = await admin
    .from('user_profiles')
    .select('full_name')
    .eq('id', args.userId)
    .maybeSingle();
  const fullName = (profile?.full_name as string | null)?.trim() ?? '';
  const notice = renderEmailChangedNoticeEmail({
    oldEmail: previous,
    newEmail: email,
    changedAt:
      new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) +
      ' UTC',
    firstName: fullName ? fullName.split(/\s+/)[0]! : null,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  const sent = await sendEmail({
    to: previous,
    subject: notice.subject,
    html: notice.html,
    text: notice.text,
    from: notice.from,
  });
  return { email, notifiedPreviousEmail: sent.ok ? previous : null };
}
