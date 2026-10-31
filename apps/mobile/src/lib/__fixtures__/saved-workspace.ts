import { LEGACY_ACTIVE_ORG_STORAGE_KEY, SAVED_WORKSPACE_STORAGE_KEY } from '../workspace-keys';

/**
 * What AsyncStorage holds for a saved workspace (workspace-keys.ts), for the
 * tests' storage stand-ins, which describe it by meaning:
 *
 *   - with an owner: this build's one value, the workspace and the account
 *     that chose it together under one key;
 *   - with no owner: an older build's single workspace key, which is all the
 *     phones in the field hold before this update;
 *   - no workspace: nothing under either key.
 */
export function storedWorkspaceItem(
  key: string,
  saved: { orgId: string | null; ownerId: string | null },
): string | null {
  if (!saved.orgId) return null;
  if (saved.ownerId) {
    return key === SAVED_WORKSPACE_STORAGE_KEY
      ? JSON.stringify({ orgId: saved.orgId, ownerId: saved.ownerId })
      : null;
  }
  return key === LEGACY_ACTIVE_ORG_STORAGE_KEY ? saved.orgId : null;
}

/** The storage entries for a saved workspace (see storedWorkspaceItem). */
export function storedWorkspaceEntries(saved: {
  orgId: string | null;
  ownerId: string | null;
}): [string, string][] {
  return [SAVED_WORKSPACE_STORAGE_KEY, LEGACY_ACTIVE_ORG_STORAGE_KEY].flatMap((key) => {
    const item = storedWorkspaceItem(key, saved);
    return item === null ? [] : [[key, item] as [string, string]];
  });
}

/** The saved workspace a storage stand-in holds now, read back as the app writes it. */
export function savedWorkspaceIn(store: ReadonlyMap<string, string>): {
  orgId: string | null;
  ownerId: string | null;
} {
  const value = store.get(SAVED_WORKSPACE_STORAGE_KEY);
  if (value) return JSON.parse(value) as { orgId: string; ownerId: string };
  return { orgId: store.get(LEGACY_ACTIVE_ORG_STORAGE_KEY) ?? null, ownerId: null };
}
