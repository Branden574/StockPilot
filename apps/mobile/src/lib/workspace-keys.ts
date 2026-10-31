/**
 * THE SAVED WORKSPACE: the workspace (organization) the phone is in, and the
 * account that chose it, kept in AsyncStorage.
 *
 * ONE place holds the keys and reads and writes them (recurring pattern #26).
 * use-workspace.ts saves it, api.ts orgHeader() names it as
 * X-Organization-Id, and session-scope.ts stamps it on every queued outbox
 * row. Three literals used to exist; renaming one of them would have made the
 * outbox stamp organization NULL on every row, so after a workspace switch
 * rows would be sent under whichever workspace was live at send time (the
 * 404/403 terminal rejection S4a fixed), and no test would have failed.
 * workspace-keys.wiring.test.ts keeps the keys to this one module.
 *
 * WHOSE SAVED WORKSPACE IS THIS? (docket B10: a 401 burst about a second after
 * a password sign-in). The saved workspace named no account, and three exits
 * keep it on purpose for the person coming back: the biometric and MFA
 * fallbacks ("Use password instead", "Use a different account") and a session
 * the server ended. When a DIFFERENT account signed in next, its first
 * requests (/me/seen, /me/announcements, /mobile/snapshot), sent before its
 * workspace load had saved its own choice, named the previous account's
 * organization, and the server refused each with a 401: a requested
 * organization the caller is not a member of is a refusal, not a fallback
 * (api-context.ts). The cache has the same guard for the same reason
 * (cache-owner.ts).
 *
 * ONE VALUE, ONE WRITE (integrator decision 3). The workspace and its owner
 * are one JSON value under one key, written by one setItem (saveWorkspace),
 * never a workspace without its owner. The first version wrote them as two
 * keys one after the other, so a failed second write left the new workspace
 * under the previous owner, and a switch with no account known removed the
 * owner, which left a record every account trusted.
 *
 * AND THE CACHE REPAIR OWED (CACHE_REPAIR_OWED_STORAGE_KEY below): the record
 * that outlives the signals a workspace load's save erases, until the wipe
 * they call for has worked.
 *
 * A leaf module with no imports, so api.ts can use it without the cycle that
 * importing use-workspace would create (use-workspace -> sync -> api).
 */

/**
 * The older builds' key: the workspace id alone, with no owner. Every phone in
 * the field holds this one before this update. Read only as the upgrade
 * fallback, while SAVED_WORKSPACE_STORAGE_KEY is absent, and removed once that
 * key is written. (The two-key form of the first B10 version never shipped,
 * so nothing reads it.)
 */
export const LEGACY_ACTIVE_ORG_STORAGE_KEY = 'workspace.activeOrgId';

/**
 * The saved workspace and the account that chose it, as one JSON value
 * {orgId, ownerId}, both non-empty. Under the `workspace.` prefix, so every
 * exit that forgets the workspace (a deliberate sign-out, an eviction:
 * account-eviction.ts accountScopedStorageKeys) forgets it whole.
 */
export const SAVED_WORKSPACE_STORAGE_KEY = 'workspace.savedOrg';

/** The saved workspace and the account that saved it; null when absent. */
export interface SavedWorkspace {
  orgId: string | null;
  ownerId: string | null;
}

const NOTHING_SAVED: SavedWorkspace = { orgId: null, ownerId: null };

/** The stored value as a record, or null for anything saveWorkspace never writes. */
function parseSavedWorkspace(stored: string): { orgId: string; ownerId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { orgId, ownerId } = parsed as Record<string, unknown>;
  if (typeof orgId !== 'string' || !orgId || typeof ownerId !== 'string' || !ownerId) return null;
  return { orgId, ownerId };
}

/**
 * The saved workspace: this build's one value, else (only while it is absent)
 * an older build's single key, which names no owner. A value this build never
 * writes reads as nothing saved, never as the older key: the next workspace
 * load saves a good one. A storage fault is the caller's to decide: api() lets
 * it fail the request as before, the outbox reads it as nothing saved.
 */
export async function readSavedWorkspace(storage: {
  getItem(key: string): Promise<string | null>;
}): Promise<SavedWorkspace> {
  const stored = await storage.getItem(SAVED_WORKSPACE_STORAGE_KEY);
  if (stored) return parseSavedWorkspace(stored) ?? NOTHING_SAVED;
  const legacy = await storage.getItem(LEGACY_ACTIVE_ORG_STORAGE_KEY);
  return { orgId: legacy || null, ownerId: null };
}

/**
 * The workspace an OLDER BUILD saved after this build last saved its own
 * value, or null (docket B10 review).
 *
 * This build removes the older key whenever it saves (saveWorkspace), so the
 * older key BESIDE this build's value was written since by an older build:
 * after a rolled-back phone update the older app reads and writes only that
 * key, and its pulls fill the cache with its workspace. Once this build is
 * back, its own value, read first, is still the one from before the rollback.
 * (Or the older key was left by a removal that failed, which saveWorkspace
 * only reports.) Never a workspace to choose, name or stamp, since its owner
 * is unknown: the workspace load takes it only as one the cache may hold
 * (use-workspace.ts). The older key alone is today's phones' saved workspace,
 * read as the upgrade fallback (readSavedWorkspace); this answers null then.
 */
export async function readOlderBuildWorkspaceSince(storage: {
  getItem(key: string): Promise<string | null>;
}): Promise<string | null> {
  if (!(await storage.getItem(SAVED_WORKSPACE_STORAGE_KEY))) return null;
  return (await storage.getItem(LEGACY_ACTIVE_ORG_STORAGE_KEY)) || null;
}

/**
 * Save `orgId` as `ownerId`'s chosen workspace: ONE setItem holding both, so a
 * failure leaves the previous record exactly as it was (and throws, for the
 * caller to treat as not saved). Never a workspace without its owner: with no
 * account to name, nothing is saved. Then the older builds' key is removed;
 * the one value is read first, so a removal that fails is only reported.
 */
export async function saveWorkspace(
  storage: {
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  },
  orgId: string,
  ownerId: string,
): Promise<void> {
  if (!orgId || !ownerId) {
    throw new Error('A workspace is saved only with the account that chose it.');
  }
  await storage.setItem(SAVED_WORKSPACE_STORAGE_KEY, JSON.stringify({ orgId, ownerId }));
  try {
    await storage.removeItem(LEGACY_ACTIVE_ORG_STORAGE_KEY);
  } catch (err) {
    console.warn('[workspace] clearing the older saved workspace key failed', err);
  }
}

/**
 * A CACHE REPAIR OWED (docket B10, integrator decision cache_clear_order).
 *
 * The workspace load clears the cache when it may hold another workspace's
 * rows: another account's saved workspace that this account does not choose,
 * this account's saved workspace once it has left it, an older app's key
 * beside this build's value (use-workspace.ts resetCache). Every one of those
 * signals is erased by the load's own save, which runs BEFORE its wipe (a
 * pull asked for after the wipe must name the workspace chosen): the save
 * replaces the record and removes the older key (saveWorkspace above). So a
 * wipe that failed, or one the app was closed before it ran (it waits its
 * turn in the transaction queue, db.ts withDbTransaction), left nothing to
 * tell the next load, and the other workspace's rows stayed, its purchase
 * orders for good: no pull ever sweeps one (sync.ts). A workspace switch
 * saves and then wipes the same way.
 *
 * So the repair is recorded as owed BEFORE the save that erases its signal,
 * and recorded done only once a wipe has worked; until then every workspace
 * load clears the cache again before it shows a workspace. The record of a
 * photo clear still owed works the same way (cache-owner.ts).
 *
 * In AsyncStorage, the store of the signals it stands in for, written before
 * the save as one setItem: the record is exactly as durable as the signal it
 * outlives. And outside the `workspace.` prefix: the debt is the device's
 * cache's, not the account's, so the sign-out and eviction that forget the
 * account's keys leave it (account-eviction.ts accountScopedStorageKeys). Its
 * value is the time it was recorded; any value at all means a repair is owed.
 * It never names a workspace or an account.
 */
export const CACHE_REPAIR_OWED_STORAGE_KEY = 'sp_cache_repair_owed';

/** Whether a cache repair is owed (see CACHE_REPAIR_OWED_STORAGE_KEY). A
 *  storage fault is its caller's, as for readSavedWorkspace. */
export async function readCacheRepairOwed(storage: {
  getItem(key: string): Promise<string | null>;
}): Promise<boolean> {
  return (await storage.getItem(CACHE_REPAIR_OWED_STORAGE_KEY)) !== null;
}

/** Record a cache repair as owed, before the save that erases its signal.
 *  Throws when it could not be written: the caller must then not save. */
export async function recordCacheRepairOwed(storage: {
  setItem(key: string, value: string): Promise<void>;
}): Promise<void> {
  await storage.setItem(CACHE_REPAIR_OWED_STORAGE_KEY, new Date().toISOString());
}

/** Record the cache repair done: only once a wipe asked for after the save has
 *  resolved. A removal that fails leaves one more repair for the next load. */
export async function recordCacheRepairDone(storage: {
  removeItem(key: string): Promise<void>;
}): Promise<void> {
  await storage.removeItem(CACHE_REPAIR_OWED_STORAGE_KEY);
}

/**
 * The saved workspace that `userId`'s REQUESTS may name (api.ts orgHeader), and
 * the one its workspace load starts from (use-workspace.ts), or null to name
 * none (the server then answers for the account's own default, the workspace
 * its workspace load chooses when nothing usable is saved).
 *
 *   - saved by this account: that workspace;
 *   - saved by another account: none;
 *   - saved by an older build (no owner): that workspace, as every request
 *     named it before. Naming none would have the server answer for the
 *     default organization while the screen shows the saved one, and the
 *     server checks membership on every request. The next workspace load
 *     records the owner;
 *   - an owned workspace with nobody signed in: none.
 */
export function savedWorkspaceFor(saved: SavedWorkspace, userId: string | null): string | null {
  if (!saved.orgId) return null;
  if (!saved.ownerId) return saved.orgId;
  return saved.ownerId === userId ? saved.orgId : null;
}

/**
 * The saved workspace that `userId`'s QUEUED WORK may carry (session-scope.ts):
 * only one this very account saved, or null. Stricter than savedWorkspaceFor
 * on an older build's record (no owner), which may be another account's
 * choice, left by a fallback sign-out on that build: a queued row is sent
 * later, without a person looking, so it is stamped with, and a row with no
 * workspace of its own is sent under, only a workspace its own account chose
 * (integrator decision 3). The next workspace load records the owner.
 */
export function ownSavedWorkspace(saved: SavedWorkspace, userId: string | null): string | null {
  if (!saved.orgId || !saved.ownerId || !userId) return null;
  return saved.ownerId === userId ? saved.orgId : null;
}
