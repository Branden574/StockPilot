import 'server-only';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { isValidStoragePath, orgLogoPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';
import { keepAlive } from '@/server/services/lib/defer';

/** The bucket every organization logo is stored in. */
export const ORG_LOGO_BUCKET = 'org-logos';

function storageBase(): string {
  return (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
}

/**
 * Everything in a logo's public URL up to (and including) the bucket name,
 * i.e. the point where the BUCKET-RELATIVE object path begins. Slicing here
 * rather than after the organization folder keeps the org id inside the
 * derived path, so the storage-path shape check validates that segment too.
 */
export function orgLogoBucketUrlPrefix(): string {
  return `${storageBase()}/storage/v1/object/public/${ORG_LOGO_BUCKET}/`;
}

/**
 * The object path (`{org}/{file}`) an organization's logo link names, or null
 * when the link is not this organization's logo object in the logo bucket: an
 * empty value, a link on another host or to another bucket, another
 * organization's folder, a nested folder, or a path that steps out of the
 * folder (isValidStoragePath with the shape pinned to `organizationId`). A
 * query string (an older `?t=` cache-buster) is ignored. With no storage
 * address configured, no link is one of ours, and a value that is not a
 * string is no link. Never throws. Null always means "nothing of this
 * organization's to touch".
 */
export function orgLogoObjectPath(
  url: string | null | undefined,
  organizationId: string,
): string | null {
  if (typeof url !== 'string' || !url || !storageBase()) return null;
  const prefix = orgLogoBucketUrlPrefix();
  const noQuery = url.split('?')[0] ?? url;
  if (!noQuery.startsWith(prefix)) return null;
  const path = noQuery.slice(prefix.length);
  return isValidStoragePath(path, orgLogoPathShape(organizationId)) ? path : null;
}

/**
 * After an organization's logo column was saved (a new logo, or cleared),
 * remove the object the column held before, so a replaced or removed logo
 * does not stay in storage.
 *
 * Only when the previous value names THIS organization's logo object
 * (orgLogoObjectPath), and never when it names the object the column holds
 * now. Every writer of the column calls this once its save succeeded; a
 * failed save must not call it.
 *
 * Removed with the service-role client, the client the logo action already
 * uses to check and remove uploads in this bucket. The caller has already
 * held the person to owner or admin of `organizationId`, and the path is
 * pinned to that organization's folder above.
 *
 * Best effort: never throws or rejects. A failed removal is reported (the
 * organization id only, no object path) and the save stands.
 *
 * KEPT ALIVE PAST THE RESPONSE, like audit(): the removal starts here and is
 * handed to after() (lib/defer.ts keepAlive), so the caller need not wait for
 * storage before it answers (`void removePreviousOrgLogo(...)`), and the
 * platform keeps the invocation running until the removal has answered. The
 * returned promise is that same removal.
 */
export function removePreviousOrgLogo(input: {
  organizationId: string;
  previousUrl: string | null | undefined;
  savedUrl: string | null | undefined;
}): Promise<void> {
  const removal = removeNow(input);
  keepAlive(removal);
  return removal;
}

async function removeNow(input: {
  organizationId: string;
  previousUrl: string | null | undefined;
  savedUrl: string | null | undefined;
}): Promise<void> {
  const previousPath = orgLogoObjectPath(input.previousUrl, input.organizationId);
  if (!previousPath) return;
  if (previousPath === orgLogoObjectPath(input.savedUrl, input.organizationId)) return;

  // The report carries the organization id only; the object path is taken
  // out of the storage message, so a report names no object.
  const context = {
    tag: 'org.logo.remove_previous',
    level: 'warning' as const,
    extra: { organizationId: input.organizationId, source: 'web' },
  };
  try {
    const { error } = await createAdminClient().storage.from(ORG_LOGO_BUCKET).remove([previousPath]);
    if (error) {
      void reportError(
        new Error(`org logo: previous object not removed: ${error.message.split(previousPath).join('<object>')}`),
        context,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    void reportError(
      new Error(`org logo: previous object not removed: ${message.split(previousPath).join('<object>')}`),
      context,
    );
  }
}
