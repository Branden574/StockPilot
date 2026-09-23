/**
 * Which workspace (organization) the phone is in when it starts, and whether
 * that choice has to be written down.
 *
 * THE DEFECT THIS CLOSES (found 2026-09-23 on the simulator). Every /api/v1
 * call names its workspace with X-Organization-Id, read from AsyncStorage
 * (`workspace.activeOrgId`, api.ts orgHeader). Sign-out deletes that key, and
 * hydrate() then picked `orgs[0]` for the SCREEN without saving it. With no
 * header the server answers for the user's default organization instead, so a
 * member of two organizations saw one workspace in every direct read (Home,
 * Items) while the snapshot pull, starting a count, posting a count and the
 * cycle-count history all ran against the other. The history screen, which
 * refuses an answer for a workspace other than the one shown, just spun.
 *
 * THE RULE, in the server's own order (api-context.ts pickActiveMembership):
 *   1. the stored workspace, while the user is still a member of it;
 *   2. otherwise the profile's default organization, if still a member;
 *   3. otherwise the first membership.
 * The result is always saved, so the header and the screen agree from the
 * first request on.
 *
 * The device cache (SQLite) holds whatever workspace the API was answering
 * for. `resetCache` is true only when that may not be the chosen one: a stored
 * workspace the user has left (every call was refused, the cache is stale),
 * or no stored workspace and no usable default (the server's own last resort
 * may have picked another). A single-organization member, and anyone whose
 * default is the chosen workspace, keeps their cache. Queued offline work
 * (pending_actions) is never part of a reset.
 */
export interface WorkspaceChoice {
  activeOrgId: string | null;
  /** Write activeOrgId to storage (it differs from what is stored). */
  persist: boolean;
  /** Clear the org-scoped cache and pull a full snapshot for activeOrgId. */
  resetCache: boolean;
}

export function chooseActiveOrg(input: {
  /** The user's accepted memberships, in the order the switcher lists them. */
  orgIds: readonly string[];
  /** What AsyncStorage holds, or null. */
  stored: string | null;
  /** user_profiles.default_organization_id, or null when unset or unread. */
  profileDefault: string | null;
}): WorkspaceChoice {
  const isMember = (id: string | null): id is string => id !== null && input.orgIds.includes(id);
  const activeOrgId = isMember(input.stored)
    ? input.stored
    : isMember(input.profileDefault)
      ? input.profileDefault
      : (input.orgIds[0] ?? null);
  if (activeOrgId === null) return { activeOrgId: null, persist: false, resetCache: false };

  // The workspace the API was answering for before this choice.
  const apiWorkspace = input.stored !== null ? input.stored : isMember(input.profileDefault) ? input.profileDefault : null;
  return {
    activeOrgId,
    persist: activeOrgId !== input.stored,
    resetCache: apiWorkspace !== activeOrgId,
  };
}
