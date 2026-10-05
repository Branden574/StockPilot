/**
 * Who uploaded a PO import, in words, for the web list and detail pages and the
 * phone's list and review screens, so no platform names the same person
 * differently.
 *
 * po_imports.uploaded_by is a NOT NULL reference to user_profiles(id) (0010),
 * and each surface looks those rows up under the VIEWER's RLS, never a service
 * role. user_profiles_select_orgmates (0003) shows a profile only when its
 * owner still has a membership row in an org the viewer belongs to. The viewer
 * is a member of the import's org, so an uploader whose profile does not come
 * back has left it: a former member. Since 0393 an uploader can delete their
 * account: the key is ON DELETE SET NULL, the import is kept, and its
 * deleted_users marker records the uploader column, which reads "Deleted user"
 * (people/deleted-user).
 *
 * A lookup that FAILED is a different answer and gets a different label: "—",
 * reported by the caller, never "Former member" for everyone on the page.
 */

import { DELETED_USER_LABEL, isDeletedUserRef } from '../people/deleted-user';

/** The uploader's user_profiles columns the label is built from. */
export interface PoImportUploaderProfile {
  full_name: string | null;
  email: string | null;
}

/** The uploader has no profile the viewer can read: they left the org. */
export const PO_IMPORT_UPLOADER_FORMER_MEMBER = 'Former member';
/** A readable profile with neither a name nor an email. */
export const PO_IMPORT_UPLOADER_UNKNOWN = 'Unknown';
/** The name lookup failed, so who it was is not known on this render. */
export const PO_IMPORT_UPLOADER_UNAVAILABLE = '—';
/** The uploader deleted their account (0393): the import keeps a stamp instead. */
export const PO_IMPORT_UPLOADER_DELETED = DELETED_USER_LABEL;

/**
 * The label for one import's uploader: "Deleted user" when the uploader column
 * is null and stamped in the row's deleted_users (0393); otherwise full name,
 * else email, else "Unknown"; "Former member" when no profile came back; "—"
 * when the lookup failed.
 *
 * `profiles` is the lookup's answer keyed by user id, or null when the lookup
 * failed. `marks` is the import row's deleted_users value (old builds and rows
 * from before 0393 pass nothing). Both name sides are trimmed with `||`, so a
 * blank full name falls through to the email instead of rendering an empty
 * label.
 */
export function poImportUploaderLabel(
  profiles: ReadonlyMap<string, PoImportUploaderProfile> | null,
  uploaderId: string | null | undefined,
  marks?: unknown,
): string {
  if (!uploaderId && isDeletedUserRef(marks, 'uploaded_by')) return PO_IMPORT_UPLOADER_DELETED;
  if (profiles === null) return PO_IMPORT_UPLOADER_UNAVAILABLE;
  if (!uploaderId) return PO_IMPORT_UPLOADER_UNKNOWN;
  const profile = profiles.get(uploaderId);
  if (!profile) return PO_IMPORT_UPLOADER_FORMER_MEMBER;
  return profile.full_name?.trim() || profile.email?.trim() || PO_IMPORT_UPLOADER_UNKNOWN;
}
