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
 *
 * NOTE: this default is deliberately PERMISSIVE (show everything until proven
 * otherwise). That is safe only because navigation is cosmetic — actual access
 * is independently gated server-side (assertModuleEnabled + RLS), so a briefly
 * over-shown tab for a disabled module 403s on use rather than leaking data.
 * The nav is NOT an entitlement boundary.
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
 * Module-level subscriber set — notified by `refreshEnabledModules()`.
 * Mirrors the `listeners` pattern used in `use-workspace.ts`.
 */
const listeners = new Set<() => void>();

/**
 * Notify all active `useEnabledModules` hooks to re-read the persisted
 * module set. Call this after a snapshot pull completes (e.g. on org switch).
 */
export function refreshEnabledModules(): void {
  for (const fn of listeners) fn();
}

/**
 * React hook returning the current org's enabled module set, defaulting to
 * DEFAULT_ENABLED_MODULES until a persisted value is read.
 *
 * Re-reads when `refreshEnabledModules()` is called (e.g. after an in-session
 * org switch triggers a fresh snapshot pull). This fixes the Phase-1 limitation
 * where the drawer/tabs would not update their entitlements without a remount.
 */
export function useEnabledModules(): Set<ModuleId> {
  const [modules, setModules] = React.useState<Set<ModuleId>>(DEFAULT_ENABLED_MODULES);

  React.useEffect(() => {
    let cancelled = false;
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      const persisted = await readPersistedEnabledModules();
      if (cancelled || !persisted) return;
      setModules(persisted);
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      listeners.delete(reread);
    };
  }, []);

  return modules;
}
