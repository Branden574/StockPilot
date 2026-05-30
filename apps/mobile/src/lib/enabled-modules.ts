import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';
import * as React from 'react';

import { getMeta } from './db';

/**
 * Source of truth for the current org's enabled module set on mobile.
 *
 * The snapshot endpoint (api/v1/mobile/snapshot) returns `enabledModules`
 * as a string[]; sync.ts persists it under this meta key as JSON. The drawer
 * (drawer-content) and the bottom-tab gating ((tabs)/_layout) both read it
 * via `useEnabledModules()` so they stay in lockstep with the registry —
 * exactly like the web sidebar (Task 9).
 *
 * Default-while-loading is DEFAULT_MODULE_IDS (the charter-school pack, which
 * is the superset that covers every optional module with a mobile placement).
 * That guarantees the grandfathered "all modules on" org never sees a
 * partial/empty drawer or a tab flicker out while offline or before the first
 * sync of this build lands a persisted value.
 */
export const ENABLED_MODULES_META_KEY = 'enabled_modules';

/** The default set used until a snapshot has persisted real values. */
export const DEFAULT_ENABLED_MODULES: Set<ModuleId> = new Set(DEFAULT_MODULE_IDS);

/**
 * Reads the persisted enabled-module set. Returns null when nothing has been
 * persisted yet (no value, or unparseable) so callers can fall back to the
 * default rather than treating "not synced yet" as "no optional modules".
 */
export async function readPersistedEnabledModules(): Promise<Set<ModuleId> | null> {
  const raw = await getMeta(ENABLED_MODULES_META_KEY);
  if (raw == null) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return new Set(arr.filter((m): m is ModuleId => typeof m === 'string') as ModuleId[]);
  } catch {
    return null;
  }
}

/**
 * React hook returning the current org's enabled module set, defaulting to
 * DEFAULT_ENABLED_MODULES until a persisted value is read. Re-reads on a
 * bumpable `version` so a fresh sync can refresh consumers if needed; for the
 * grandfathered org the default already matches, so there's no visible change.
 */
export function useEnabledModules(): Set<ModuleId> {
  const [modules, setModules] = React.useState<Set<ModuleId>>(DEFAULT_ENABLED_MODULES);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const persisted = await readPersistedEnabledModules();
      if (cancelled || !persisted) return;
      setModules(persisted);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return modules;
}
