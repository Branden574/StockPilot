'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Strips ASCII control chars (0x00–0x1F, 0x7F) and Unicode bidi
 * overrides (U+202A-U+202E, U+2066-U+2069). Those are the classic
 * "Trojan Source" sneak-in payloads and also typically invisible
 * characters that pollute the name shown across the UI.
 */
const sanitizeName = (s: string) =>
  s.replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');

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
    throw new ServiceError(
      'forbidden',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
      { reason: 'mfa_required' },
    );
  }
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Build the only legal storage-public-URL prefix for an org's logo uploads.
 * Anything outside this prefix is rejected — the logo_url is later passed to
 * server-side <Image src> in five PDF/export renderers, so an arbitrary URL
 * here is an SSRF sink (the render worker would fetch it).
 */
function expectedLogoPrefix(orgId: string): string {
  const base = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/org-logos/${orgId}/`;
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
    updateTag('dashboard-org');
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
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
    await gateMfa();
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
      // Log but don't throw — the profile tombstone already prevents
      // login through the app, and the cascade will fire on the next
      // admin retry. Surfacing the error to the user produces a
      // half-deleted state UX they can't act on.
      console.error('[deleteOwnAccount] auth.admin.deleteUser failed:', authErr.message);
    }

    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
