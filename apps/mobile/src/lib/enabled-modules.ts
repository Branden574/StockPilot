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
const listeners = new Set<() => Promise<void>>();

/**
 * Notify all active `useEnabledModules` hooks to re-read the persisted
 * module set. Call this after a snapshot pull completes (e.g. on org switch).
 * Resolves once every one has read it (a workspace switch waits for that
 * before it shows the new workspace); never rejects.
 */
export function refreshEnabledModules(): Promise<void> {
  return Promise.all([...listeners].map((fn) => fn().catch(() => undefined))).then(() => undefined);
}

/** The hooks whose latest read threw ('failed'), until a read comes back. */
const failedReads = new Set<() => Promise<void>>();

/**
 * Read again in every hook whose latest read threw, and only those: called at
 * the end of every pull (sync.ts), so a screen whose read failed does not
 * stay 'unreadable' until Try again or a remount when the saved set did not
 * change. Never rejects.
 */
export function rereadFailedEnabledModules(): Promise<void> {
  return Promise.all([...failedReads].map((fn) => fn().catch(() => undefined))).then(
    () => undefined,
  );
}

/**
 * React hook returning the current org's enabled module set, defaulting to
 * DEFAULT_ENABLED_MODULES until a persisted value is read (a read that throws
 * keeps the set shown).
 *
 * Re-reads when `refreshEnabledModules()` is called (e.g. after an in-session
 * org switch triggers a fresh snapshot pull). This fixes the Phase-1 limitation
 * where the drawer/tabs would not update their entitlements without a remount.
 */
export function useEnabledModules(): Set<ModuleId> {
  return useEnabledModulesState().modules;
}

/** The module set, and whether the saved set has been read from the device yet. */
export interface EnabledModulesState {
  /** The saved set; DEFAULT_ENABLED_MODULES until one is read, and when none is saved. */
  modules: Set<ModuleId>;
  /** The saved set has been read once: found, absent or unreadable, or not
   *  answered within MODULES_READ_WAIT_MS. Until then `modules` is the
   *  default, not this workspace's set. Never goes back to false. */
  read: boolean;
  /** What the device store last answered: false until a read has come back
   *  (never the wait), however long it takes; then 'saved' (`modules` is the
   *  saved set) or 'nothing-saved' (no set, or one that does not parse:
   *  `modules` is only the menu's default or the set shown before), or
   *  'failed' when the latest read threw (a re-read after a workspace switch
   *  that throws must not let the previous workspace's set stand). Never goes
   *  back to false. A screen deciding what it reads or shows uses this alone
   *  (screen-access.ts); the menu keeps `modules`. */
  answered: false | 'saved' | 'nothing-saved' | 'failed';
}

/**
 * How long a screen waits for the first read of the saved set, as for the
 * saved permissions (use-effective-permissions.ts
 * SAVED_PERMISSIONS_READ_WAIT_MS): a read that has not answered by then
 * counts as read with nothing saved, and the set still replaces the default
 * when it lands.
 */
export const MODULES_READ_WAIT_MS = 2000;

/**
 * useEnabledModules with whether the saved set has been read, and what the
 * device store answered: for a screen that must not decide from the
 * permissive default (screen-access.ts). The module set itself follows the
 * same rules as useEnabledModules.
 */
export function useEnabledModulesState(): EnabledModulesState {
  const [state, setState] = React.useState<EnabledModulesState>({
    modules: DEFAULT_ENABLED_MODULES,
    read: false,
    answered: false,
  });

  React.useEffect(() => {
    let cancelled = false;
    let wait: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      wait = null;
      if (!cancelled) setState((prev) => (prev.read ? prev : { ...prev, read: true }));
    }, MODULES_READ_WAIT_MS);
    const stopWaiting = (): void => {
      if (wait !== null) clearTimeout(wait);
      wait = null;
    };
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      let persisted: Set<ModuleId> | null;
      try {
        persisted = await readPersistedEnabledModules();
      } catch {
        // The device store could not be read: the last set read stays for
        // the menu, a first read still counts as read, and the read failed.
        stopWaiting();
        if (!cancelled) {
          failedReads.add(reread);
          setState((prev) => ({ ...prev, read: true, answered: 'failed' }));
        }
        return;
      }
      stopWaiting();
      failedReads.delete(reread);
      if (cancelled) return;
      // Nothing saved keeps the set already shown, as before.
      setState((prev) => ({
        modules: persisted ?? prev.modules,
        read: true,
        answered: persisted ? 'saved' : 'nothing-saved',
      }));
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      stopWaiting();
      listeners.delete(reread);
      failedReads.delete(reread);
    };
  }, []);

  return state;
}
