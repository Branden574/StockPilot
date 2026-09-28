/**
 * A person on an exception occurrence (acknowledger, timeline actor, photo
 * uploader) as the READER can see them. Shared by the occurrence service and
 * the evidence read so both word people the same way.
 */

/** `label` is their name, else email; "Former member" when the profile is no
 *  longer visible (they left, or the account was deleted). */
export interface OccurrencePerson {
  id: string | null;
  label: string;
}

export type ProfileEmbed = { full_name: string | null; email: string | null } | null;

/** The profile as the reader sees it. user_profiles_select_orgmates shows a
 *  profile only while its owner still belongs to one of the reader's orgs, so
 *  an invisible profile (or a deleted account, which nulls the id) is a
 *  former member. Same wording as the PO-imports uploader label. */
export function personFor(id: string | null, profile: ProfileEmbed | undefined): OccurrencePerson {
  if (!profile) return { id, label: 'Former member' };
  return { id, label: profile.full_name?.trim() || profile.email?.trim() || 'Unknown' };
}
