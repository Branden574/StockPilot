'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { getSessionMemberships, requireOrgContext, requireSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { isSniffedKindAllowedInBucket, sniffImage } from '@/lib/image-signature';
import { fetchObjectPrefix } from '@/lib/storage-object-prefix';
import { isValidStoragePath, orgLogoPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError, mfaGateError, withContext } from '@/server/services/context';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

import { err, ok, UNSAFE_DISPLAY_NAME_CHARS, type ActionResult } from '@stockpilot/core';

/**
 * Strips ASCII control chars (0x00–0x1F, 0x7F) and Unicode bidi
 * overrides (U+202A-U+202E, U+2066-U+2069). Those are the classic
 * "Trojan Source" sneak-in payloads and also typically invisible
 * characters that pollute the name shown across the UI.
 *
 * The character class itself lives in core as UNSAFE_DISPLAY_NAME_CHARS and
 * is SHARED with the PO-import display-name schema. Two slightly different
 * definitions of "unsafe name character" in one codebase is how one of them
 * ends up wrong; the class is non-global there (no lastIndex state), so the
 * /g form for replace() is rebuilt from its source here.
 */
const sanitizeName = (s: string) =>
  s.replace(new RegExp(UNSAFE_DISPLAY_NAME_CHARS.source, 'g'), '');

const nameSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .max(80)
    .transform((s) => sanitizeName(s).trim())
    .nullable(),
});

/**
 * Ensure that any privileged profile mutation goes through the same
 * org-MFA gate that `assertPermission` enforces inside services. We
 * call `withContext()` rather than `requireOrgContext()` directly so
 * the resolved `mfaSatisfied` boolean is honored for `all_required`
 * orgs.
 */
async function gateMfa(): Promise<void> {
  const ctx = await withContext();
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    // Shape chosen by enrollment — see mfaGateError. An enrolled user must
    // get 'aal2_required' so the step-up modal fires instead of telling
    // someone who already has a factor to enroll one.
    throw mfaGateError(ctx);
  }
}

/**
 * The MFA posture of the COOKIE SESSION alone — no org involved.
 *
 * `gateMfa()` above answers "what does this user's ORG demand?", which is the
 * right question for every org-scoped mutation here. It is the wrong question,
 * and an unanswerable one, for a user who has no org: `withContext()` resolves
 * through `requireOrgContext()`, which answers a membership-less session with
 * `redirect('/onboarding')` — a throw, not a value (see SP-129 below).
 *
 * So this reads the same two facts `resolveMfaState` reads, straight off the
 * session: is a factor VERIFIED, and is the session at aal2. Enrollment still
 * escalates (HI-6) — losing your org must not lose the rule that a factor you
 * enrolled has to be satisfied. Shaped like `ServiceContext`'s MFA triple so
 * `mfaGateError` picks the same error shape in both paths.
 */
async function resolveSessionMfaPosture(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean }> {
  try {
    const { data: factors, error } = await supabase.auth.mfa.listFactors();
    if (error) throw new Error(error.message);
    const enrolled = (factors?.totp ?? []).some((f) => f.status === 'verified');
    if (!enrolled) return { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false };
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return {
      mfaRequired: true,
      mfaSatisfied: aal?.currentLevel === 'aal2',
      mfaEnrolled: true,
    };
  } catch (e) {
    // Fail CLOSED, byte-for-byte the posture `resolveMfaState` takes in
    // services/context.ts: an unreadable factor list must never read as "no
    // MFA required" on a destructive action. The unenrolled shape is chosen
    // deliberately — we do not KNOW there is a factor, and telling someone
    // with no factor to "re-authenticate with MFA" fires a step-up modal they
    // can never satisfy.
    console.error('[profile] session MFA posture read failed:', e);
    return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
  }
}

/**
 * SP-129 — the MFA gate for SELF-SERVICE account actions, which must work for
 * a user who has NO accepted membership.
 *
 * That cohort is real and not small: every signup that abandons /onboarding,
 * and everyone removed from their last org by `TeamService.removeMember`
 * (which deletes the membership row and leaves the auth user + profile alive).
 * For them `gateMfa()` -> `withContext()` -> `requireOrgContext()` throws
 * NEXT_REDIRECT, which the catch-all below used to translate into
 * `internal_error: 'NEXT_REDIRECT'` (recurring pattern #23) — so the one
 * action App Store 5.1.1(v) and GDPR require to always work was the one action
 * they could never complete.
 *
 * A member keeps the org gate EXACTLY as before: this is not a way around an
 * org's mfa_policy, only an answer for the case where there is no org to ask.
 */
async function gateMfaForSelfService(): Promise<void> {
  // Shares loadSessionAndContext's single membership query with requireSession
  // (React.cache), so this costs no extra round trip.
  const memberships = await getSessionMemberships();
  if (memberships.length > 0) {
    await gateMfa();
    return;
  }
  const supabase = await createClient();
  const posture = await resolveSessionMfaPosture(supabase);
  if (posture.mfaRequired && !posture.mfaSatisfied) throw mfaGateError(posture);
}

/**
 * The one translation from a thrown error to an ActionResult, shared by every
 * action in this file.
 *
 * Two things it must do that the four hand-rolled catch blocks did not:
 *
 *  1. RETHROW Next control-flow errors. `redirect()` is implemented as a THROW
 *     carrying a `digest`; catching it turned "you are signed out, go to
 *     /signin" into `internal_error: 'NEXT_REDIRECT'` — a dead end for the
 *     user and a false error for the logs (recurring pattern #23).
 *  2. Forward `ServiceError.details`. `mfaGateError` puts `reason:
 *     'aal2_required'` there precisely so an ENROLLED user gets the step-up
 *     modal instead of an "enroll in MFA" message; dropping details silently
 *     undid that choice (email-routing-settings.ts surfaces it the same way).
 */
function actionErrorFrom(e: unknown): ActionResult<never> {
  if (isNextControlFlowError(e)) throw e;
  if (e instanceof ServiceError) return err(e.code, e.message, e.details);
  return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
}

export async function updateProfileNameAction(input: {
  fullName: string | null;
}): Promise<ActionResult<void>> {
  const parsed = nameSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid name',
    );
  }
  try {
    // S2.3: honor MFA gate before mutating profile fields shown across
    // the app. Falls back to requireSession-equivalent if no org.
    const ctx = await requireOrgContext();
    await gateMfa();
    const supabase = await createClient();
    // Load the old value so the audit row carries a real before/after
    // pair, not just the new value.
    const { data: prev } = await supabase
      .from('user_profiles')
      .select('full_name')
      .eq('id', ctx.userId)
      .maybeSingle();
    const newName = parsed.data.fullName;
    const { error } = await supabase
      .from('user_profiles')
      .update({ full_name: newName })
      .eq('id', ctx.userId);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'user.profile.updated',
      entityType: 'user',
      entityId: ctx.userId,
      before: { full_name: (prev as { full_name?: string | null } | null)?.full_name ?? null },
      after: { full_name: newName },
    });
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    return actionErrorFrom(e);
  }
}

const urlSchema = z.object({
  url: z.string().url().nullable(),
});

/**
 * Build the only legal storage-public-URL prefix for this user's avatar
 * uploads. Anything that doesn't start with this prefix is rejected,
 * which blocks both arbitrary-URL injection and uploads that landed in
 * the wrong user's folder.
 */
function expectedAvatarPrefix(userId: string): string {
  const base = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/user-avatars/${userId}/`;
}

/**
 * Parses the storage object key (e.g. `<userId>/abc.webp`) out of a
 * public URL. Returns null when the URL doesn't match the expected
 * bucket public-URL shape — callers should treat that as "nothing to
 * delete" rather than an error.
 */
function avatarStorageKey(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  // Strip any query string (older rows persisted ?t= cache-busters).
  const noQuery = publicUrl.split('?')[0] ?? publicUrl;
  const marker = '/storage/v1/object/public/user-avatars/';
  const ix = noQuery.indexOf(marker);
  if (ix === -1) return null;
  const key = noQuery.slice(ix + marker.length);
  return key.length > 0 ? key : null;
}

/**
 * Best-effort remove the previous avatar object from storage so we
 * don't leak orphan files. Logged but never throws — a failed cleanup
 * must not block the user-facing avatar-update happy path.
 */
async function removeOrphanAvatar(prevUrl: string | null | undefined): Promise<void> {
  const key = avatarStorageKey(prevUrl);
  if (!key) return;
  try {
    const supabase = await createClient();
    const { error } = await supabase.storage.from('user-avatars').remove([key]);
    if (error) console.error('[avatar] remove previous failed:', error.message);
  } catch (e) {
    console.error('[avatar] remove previous threw:', e);
  }
}

/**
 * Persists a new avatar_url on the user_profile. The actual file upload
 * happens client-side via supabase.storage; this just records the URL
 * the bucket handed back. Pass null to clear the avatar.
 */
export async function setAvatarUrlAction(input: {
  url: string | null;
}): Promise<ActionResult<void>> {
  const parsed = urlSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid URL');
  }
  try {
    // S2.3: honor MFA gate. We use requireOrgContext() + an explicit
    // withContext() MFA check so the action behaves the same as any
    // permission-gated service call.
    const ctx = await requireOrgContext();
    await gateMfa();

    // S1.2: validate the URL is within the user's own avatar prefix.
    // Anything else (a different user's folder, an arbitrary external
    // URL, a signed-URL injection) is rejected before we touch the DB.
    if (parsed.data.url !== null) {
      const prefix = expectedAvatarPrefix(ctx.userId);
      // Strip any query string before the prefix check so callers that
      // accidentally send a cache-buster still validate cleanly, even
      // though we persist the URL without the query string (S2.6).
      const candidate = parsed.data.url.split('?')[0] ?? parsed.data.url;
      if (!candidate.startsWith(prefix)) {
        return err('validation_error', 'Avatar URL must point at your own avatar in the StockPilot storage bucket.');
      }
    }

    // S2.6: drop the ?t= cache-buster before persisting. revalidatePath
    // below revalidates the dashboard layout, which is what makes Next
    // refetch the topbar avatar without a hard reload.
    const persistUrl =
      parsed.data.url === null
        ? null
        : (parsed.data.url.split('?')[0] ?? parsed.data.url);

    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('user_profiles')
      .select('avatar_url')
      .eq('id', ctx.userId)
      .maybeSingle();
    const prevUrl = (prev as { avatar_url?: string | null } | null)?.avatar_url ?? null;

    const { error } = await supabase
      .from('user_profiles')
      .update({ avatar_url: persistUrl })
      .eq('id', ctx.userId);
    if (error) throw new ServiceError('internal_error', error.message);

    // S1.1: clean up the previous storage object so users don't leak
    // an orphan per upload. Skip when the previous key matches the new
    // one (re-record of an unchanged URL) so a no-op save doesn't
    // delete the file we just persisted.
    const prevKey = avatarStorageKey(prevUrl);
    const nextKey = avatarStorageKey(persistUrl);
    if (prevKey && prevKey !== nextKey) {
      await removeOrphanAvatar(prevUrl);
    }

    // S1.3: audit the change (both upload-new and remove-current paths).
    await audit({
      event: 'user.profile.updated',
      entityType: 'user',
      entityId: ctx.userId,
      before: { avatar_url: prevUrl },
      after: { avatar_url: persistUrl },
    });

    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    return actionErrorFrom(e);
  }
}

/**
 * Build the only legal storage-public-URL prefix for an org's logo uploads.
 * Anything outside this prefix is rejected — the logo_url is later passed to
 * server-side <Image src> in five PDF/export renderers, so an arbitrary URL
 * here is an SSRF sink (the render worker would fetch it).
 */
function expectedLogoPrefix(orgId: string): string {
  return `${orgLogoBucketUrlPrefix()}${orgId}/`;
}

/** Everything in a logo's public URL up to (and including) the bucket name —
 *  i.e. the point where the BUCKET-RELATIVE object path begins. Slicing here
 *  rather than at `expectedLogoPrefix` keeps the org id inside the derived
 *  path, so the storage-path shape check validates that segment too instead of
 *  taking the string prefix check's word for it. */
function orgLogoBucketUrlPrefix(): string {
  const base = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/org-logos/`;
}

/**
 * Persists a new logo_url on the organization. Owner/admin only. Same
 * upload-then-record split as setAvatarUrlAction.
 */
export async function setOrgLogoUrlAction(input: {
  url: string | null;
}): Promise<ActionResult<void>> {
  const parsed = urlSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid URL');
  }
  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can change the logo.');
    }
    // SSRF guard: the logo_url is fetched server-side by the PDF/export
    // renderers (<Image src=…>), so it must point at THIS org's own logo in our
    // public storage bucket — not an arbitrary host (e.g. a metadata endpoint).
    let persistUrl: string | null = null;
    if (parsed.data.url !== null) {
      const prefix = expectedLogoPrefix(ctx.organizationId);
      const candidate = parsed.data.url.split('?')[0] ?? parsed.data.url;
      if (!candidate.startsWith(prefix)) {
        return err(
          'validation_error',
          'Logo URL must point at your organization’s logo in the StockPilot storage bucket.',
        );
      }
      // Drop any ?t= cache-buster before persisting (matches the avatar path).
      persistUrl = candidate;

      // MED-23 — verify the BYTES of the object this URL names before the URL
      // becomes the org's logo. org-logos is a PUBLIC bucket whose
      // `allowed_mime_types` pin (0046) only inspects the Content-Type header
      // the browser attached to its PUT, and that header is client-controlled:
      // an HTML document or an SVG carrying script uploads cleanly by
      // declaring `image/png`, and then lives at a permanent, unauthenticated
      // URL on the Supabase origin — which this action is about to publish
      // into every page header, every emailed PDF and every export. The logo
      // is additionally fetched server-side by five PDF renderers, which is
      // why the prefix check above already exists; bytes are the other half.
      //
      // Verify-or-delete, same shape as the maintenance-attachments
      // reference: read the object's LEADING BYTES (fetchObjectPrefix — a
      // range read; the helper widens to a full read on its own only for
      // files the 4 KB window cannot decide, e.g. an EXIF/ICC-heavy JPEG
      // logo, so the full object is normally never buffered here), sniff,
      // and on any
      // disagreement REMOVE the object and refuse — never leave an
      // unverified object reachable at a URL a client already knows.
      const objectPath = candidate.slice(orgLogoBucketUrlPrefix().length);
      // The prefix check is a PREFIX check (HI-8): `{org}/../../item-images/...`
      // starts with the expected prefix and still escapes the bucket once
      // storage-js interpolates it into a fetch() URL, so the derived path is
      // shape-validated before any storage call is made with it.
      if (!isValidStoragePath(objectPath, orgLogoPathShape(ctx.organizationId))) {
        return err(
          'validation_error',
          'Logo URL must point at your organization’s logo in the StockPilot storage bucket.',
        );
      }
      const logos = createAdminClient().storage.from('org-logos');
      const head = await fetchObjectPrefix(logos, objectPath);
      if (!head) {
        return err('validation_error', 'That logo upload could not be read. Try uploading again.');
      }
      const sniffed = sniffImage(head.prefix);
      if (!sniffed || !isSniffedKindAllowedInBucket(sniffed.kind, 'org-logos')) {
        await logos.remove([objectPath]);
        return err(
          'validation_error',
          'That file is not a PNG, JPG, WEBP or AVIF image. Pick a real image file.',
        );
      }
    }
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const { data: updated, error } = await supabase
      .from('organizations')
      .update({ logo_url: persistUrl })
      .eq('id', ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the org row didn't match — never report
    // a silent success.
    if (!updated) throw new ServiceError('not_found', 'Organization not found.');
    await audit({
      // S3.2: org logo updates are an *organization* event, not a
      // warehouse one. The pre-staged event type makes this audit
      // row queryable alongside other org-level admin changes.
      event: 'organization.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { logo_url: prev?.logo_url ?? null },
      after: { logo_url: persistUrl },
    });
    // Invalidate the cached org row in lib/dashboard/cached-org.ts so
    // the new logo appears in the dashboard shell on next nav instead
    // of being stale for up to 60s. Static cross-org tag.
    revalidateTag('dashboard-org', 'max');
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    return actionErrorFrom(e);
  }
}

const deleteAccountSchema = z.object({
  confirm: z.literal('DELETE'),
});

/**
 * Self-service account deletion. Soft-deletes the profile (sets
 * `deleted_at`), then deletes the underlying auth user via the admin
 * client which cascades to membership rows on the `user_profiles.id`
 * FK with `on delete cascade`.
 *
 * Owners of an org with other accepted members cannot delete their
 * own account — they must first transfer ownership (handled separately
 * by `team` actions). The check runs against every org membership the
 * user has, so an owner of org A who's a staff member of org B can
 * only delete after either transferring A or leaving B.
 */
export async function deleteOwnAccountAction(input: {
  confirm: string;
}): Promise<ActionResult<void>> {
  const parsed = deleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Type DELETE to confirm.');
  }
  try {
    const session = await requireSession();
    // SP-129 — NOT gateMfa(): a user with no membership must still be able to
    // delete their account. See gateMfaForSelfService.
    await gateMfaForSelfService();
    const supabase = await createClient();

    // Find every org this user owns. If any of them have another
    // accepted member, refuse the delete — the owner must transfer
    // ownership or remove the other members first.
    const { data: ownedRows } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', session.userId)
      .eq('role', 'owner')
      .not('accepted_at', 'is', null);
    const ownedOrgIds = ((ownedRows as { organization_id: string }[] | null) ?? []).map(
      (r) => r.organization_id,
    );
    if (ownedOrgIds.length > 0) {
      const { data: otherMembers } = await supabase
        .from('organization_members')
        .select('organization_id')
        .in('organization_id', ownedOrgIds)
        .neq('user_id', session.userId)
        .not('accepted_at', 'is', null)
        .limit(1);
      if ((otherMembers ?? []).length > 0) {
        return err(
          'forbidden',
          'Transfer ownership of your organization (or remove the other members) before deleting your account.',
        );
      }
    }

    // Soft-delete the profile row first — the FK is `on delete cascade`
    // on the auth.users side, so admin.deleteUser() would otherwise
    // erase the profile before we get a chance to mark it deleted for
    // historical reference (movements, audit rows, etc. all retain the
    // user_id with a tombstoned profile this way).
    const deletedAt = new Date().toISOString();
    const { error: profileErr } = await supabase
      .from('user_profiles')
      .update({ deleted_at: deletedAt })
      .eq('id', session.userId);
    if (profileErr) throw new ServiceError('internal_error', profileErr.message);

    await audit({
      event: 'user.deactivated',
      entityType: 'user',
      entityId: session.userId,
      reason: 'self_deletion',
    });

    // Now invalidate the auth user. Profile + membership rows cascade
    // via the user_profiles.id -> auth.users(id) on delete cascade FK.
    const admin = createAdminClient();
    const { error: authErr } = await admin.auth.admin.deleteUser(session.userId);
    if (authErr) {
      // ═══ SP-008 — THE TOMBSTONE DOES NOT BLOCK LOGIN ═══
      //
      // This used to log the failure and return ok(). The comment justifying
      // that said "the profile tombstone already prevents login through the
      // app, and the cascade will fire on the next admin retry". BOTH halves
      // were false, and had always been:
      //
      //   • NOTHING in any identity funnel reads user_profiles.deleted_at.
      //     loadSessionAndContext selects `disabled_at`; ACCOUNT_STATUS_COLUMNS
      //     is `'disabled_at'`; isAccountDisabled (packages/core) reads only
      //     disabled_at; 0310's is_org_member checks only disabled_at. 0171
      //     added the column with no trigger and no policy. The tombstoned user
      //     signs straight back in with every membership intact.
      //   • There is no retry. No cron, no queue, no admin tool re-attempts
      //     this delete.
      //
      // So the failure mode was: deleteUser 401s (exactly the 2026-07-21
      // service-role key outage, where every createAdminClient path failed
      // while user-authed reads stayed up), the action returns ok, the UI says
      // "Your account has been deleted." and the audit log records
      // 'user.deactivated' — while the account is entirely alive. That is a
      // false promise under App Store 5.1.1(v) / GDPR and a false audit row.
      //
      // Now: report it, end the live sessions best-effort, and TELL the user it
      // failed. `deleted_at` is deliberately left stamped — it is the marker an
      // operator (or a future retry) uses to find the half-deleted account, and
      // it is inert for login precisely because nothing reads it.
      await reportError(new Error(authErr.message), {
        tag: 'account.delete.auth_delete_failed',
        extra: { userId: session.userId, source: 'web' },
      });
      try {
        // Not silent (pattern #28): revokeAllSessionsForUser reports its own
        // failure and returns { ok: false } rather than throwing. The try/catch
        // is only for the case where the admin client itself is unusable — the
        // same dead key that broke the delete above — which must not turn a
        // reported refusal into an unhandled throw.
        await revokeAllSessionsForUser(session.userId);
      } catch (revokeErr) {
        console.error('[deleteOwnAccount] session revoke failed:', revokeErr);
      }
      return err(
        'internal_error',
        'Your account could not be deleted right now. Please try again.',
      );
    }

    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (e) {
    return actionErrorFrom(e);
  }
}
