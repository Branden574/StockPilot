/**
 * The AsyncStorage key holding the active workspace (organization) id.
 *
 * ONE copy (recurring pattern #26). use-workspace.ts writes it, api.ts
 * orgHeader() sends it as X-Organization-Id, and session-scope.ts stamps it on
 * every queued outbox row. Three literals used to exist; renaming one of them
 * would have made the outbox stamp organization NULL on every row, so after a
 * workspace switch rows would be sent under whichever workspace was live at
 * send time (the 404/403 terminal rejection S4a fixed), and no test would
 * have failed. workspace-keys.wiring.test.ts keeps it to this one place.
 *
 * A leaf module with no imports, so api.ts can use it without the cycle that
 * importing use-workspace would create (use-workspace -> sync -> api).
 */
export const ACTIVE_ORG_STORAGE_KEY = 'workspace.activeOrgId';

/**
 * WHOSE SAVED WORKSPACE IS THIS? The account that saved ACTIVE_ORG_STORAGE_KEY,
 * written beside it by every workspace load and switch (use-workspace.ts).
 *
 * THE DEFECT (docket B10: a 401 burst about a second after a password
 * sign-in). The saved workspace named no account, and three exits keep it on
 * purpose for the person coming back: the biometric and MFA fallbacks ("Use
 * password instead", "Use a different account") and a session the server
 * ended. When a DIFFERENT account signed in next, its first requests
 * (/me/seen, /me/announcements, /mobile/snapshot), sent before its workspace
 * load had saved its own choice, named the previous account's organization,
 * and the server refused each with a 401: a requested organization the caller
 * is not a member of is a refusal, not a fallback (api-context.ts). The cache
 * has the same guard for the same reason (cache-owner.ts).
 *
 * Under the `workspace.` prefix, so every exit that forgets the workspace
 * (a deliberate sign-out, an eviction) forgets its owner with it.
 */
export const ACTIVE_ORG_OWNER_STORAGE_KEY = 'workspace.activeOrgUserId';

/** The saved workspace and the account that saved it; null when absent. */
export interface SavedWorkspace {
  orgId: string | null;
  ownerId: string | null;
}

/**
 * Read both keys, one getItem each. A storage fault is the caller's to
 * decide: api() lets it fail the request as before, the outbox reads it as
 * nothing saved.
 */
export async function readSavedWorkspace(storage: {
  getItem(key: string): Promise<string | null>;
}): Promise<SavedWorkspace> {
  const [orgId, ownerId] = await Promise.all([
    storage.getItem(ACTIVE_ORG_STORAGE_KEY),
    storage.getItem(ACTIVE_ORG_OWNER_STORAGE_KEY),
  ]);
  return { orgId: orgId || null, ownerId: ownerId || null };
}

/**
 * The saved workspace that `userId`'s requests and queued work may name, or
 * null to name none (the server then answers for the account's own default,
 * the workspace its workspace load chooses when nothing usable is saved).
 *
 *   - saved by this account: that workspace;
 *   - saved by another account: none;
 *   - saved before owners were recorded (an older build): that workspace, as
 *     every request named it before. Naming none there would have the server
 *     answer for the default organization while the screen shows the saved
 *     one. The next workspace load records the owner;
 *   - an owned workspace with nobody signed in: none.
 */
export function savedWorkspaceFor(saved: SavedWorkspace, userId: string | null): string | null {
  if (!saved.orgId) return null;
  if (!saved.ownerId) return saved.orgId;
  return saved.ownerId === userId ? saved.orgId : null;
}
