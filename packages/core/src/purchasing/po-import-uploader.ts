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
 * back has left it: a former member. The row itself cannot be gone, since the
 * foreign key is ON DELETE RESTRICT.
 *
 * A lookup that FAILED is a different answer and gets a different label: "—",
 * reported by the caller, never "Former member" for everyone on the page.
 */

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

/**
 * The label for one import's uploader: full name, else email, else "Unknown";
 * "Former member" when no profile came back; "—" when the lookup failed.
 *
 * `profiles` is the lookup's answer keyed by user id, or null when the lookup
 * failed. Both sides are trimmed with `||`, so a blank full name falls through
 * to the email instead of rendering an empty label.
 */
export function poImportUploaderLabel(
  profiles: ReadonlyMap<string, PoImportUploaderProfile> | null,
  uploaderId: string | null | undefined,
): string {
  if (profiles === null) return PO_IMPORT_UPLOADER_UNAVAILABLE;
  if (!uploaderId) return PO_IMPORT_UPLOADER_UNKNOWN;
  const profile = profiles.get(uploaderId);
  if (!profile) return PO_IMPORT_UPLOADER_FORMER_MEMBER;
  return profile.full_name?.trim() || profile.email?.trim() || PO_IMPORT_UPLOADER_UNKNOWN;
}
