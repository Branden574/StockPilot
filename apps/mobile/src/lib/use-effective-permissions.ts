import { type Permission, type Role } from '@stockpilot/core';
import * as React from 'react';

import { api } from './api';
import { getMeta, setMeta } from './db';

/**
 * Source of truth for the current user's EFFECTIVE permission set on mobile —
 * static role defaults with org role/user overrides applied (web mig 0207).
 *
 * Two write paths, both persist to the same meta key + notify subscribers:
 *   • the snapshot sync (sync.ts) writes `permissions` alongside enabledModules
 *     on every pull (covers initial load, org switch, offline), and
 *   • fetchEffectivePermissions() does a light GET /api/v1/me/permissions, used
 *     by the realtime subscription so a permission change reflects without a
 *     full snapshot sync.
 *
 * The drawer (drawer-content) gates its nav on this so a revoked permission
 * hides its link — exactly like the web sidebar's ctx.permissions gating.
 *
 * Default-while-loading is `undefined` → drawerSectionsFor passes it through to
 * resolveSurface, which falls back to the STATIC role permissions. So the
 * drawer renders today's role-based nav until the effective set loads, then
 * narrows/widens per overrides — never an empty flash. (An empty persisted set
 * is also treated as "not loaded" since no real member has zero permissions.)
 *
 * Like enabled-modules, this is COSMETIC nav gating only — the API independently
 * enforces permissions server-side (assertPermission + RLS), so a briefly
 * over-shown link 403s on use rather than leaking data.
 *
 * A screen that must never decide from the static defaults reads
 * useEffectivePermissionsState() instead, which also says whether the saved
 * set has been read yet, and gates with permissionsOnceRead(): nothing until
 * it is read. The order screen does (S2 follow-up, lab walk of #378): a staff
 * member granted orders:approve by a per-user exception holds it only in the
 * saved set, and the order read with the static defaults skipped the reads
 * that decide where their approver controls apply.
 */
export const EFFECTIVE_PERMISSIONS_META_KEY = 'effective_permissions';

export async function readPersistedPermissions(): Promise<Set<Permission> | null> {
  const raw = await getMeta(EFFECTIVE_PERMISSIONS_META_KEY);
  if (raw == null) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return new Set(arr.filter((p): p is Permission => typeof p === 'string') as Permission[]);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** Notify active useEffectivePermissions() hooks to re-read the persisted set. */
export function refreshEffectivePermissions(): void {
  for (const fn of listeners) fn();
}

/**
 * Light fetch of the effective permission set → persist + notify. Used by the
 * realtime subscription (and on demand). Fail-silent: a failed fetch leaves the
 * last persisted set in place rather than blanking the nav.
 */
export async function fetchEffectivePermissions(): Promise<void> {
  try {
    const res = await api<{ role: Role; permissions: string[] }>('/api/v1/me/permissions');
    const next = JSON.stringify(Array.isArray(res.permissions) ? res.permissions : []);
    const prev = await getMeta(EFFECTIVE_PERMISSIONS_META_KEY);
    await setMeta(EFFECTIVE_PERMISSIONS_META_KEY, next);
    if (prev !== next) refreshEffectivePermissions();
  } catch {
    /* offline / transient — keep the last persisted set */
  }
}

/** The saved set, and whether it has been read from the device yet. */
export interface EffectivePermissionsState {
  /** The saved effective set. Undefined until it is read, and when nothing is
   *  saved (core `can` then answers from the role's static defaults). */
  permissions: Set<Permission> | undefined;
  /** The saved set has been read once: found, absent or unreadable. Until
   *  then an undefined `permissions` means "not read yet", not "nothing
   *  saved". Never goes back to false. */
  read: boolean;
}

const UNREAD: EffectivePermissionsState = { permissions: undefined, read: false };

export function useEffectivePermissionsState(): EffectivePermissionsState {
  const [state, setState] = React.useState<EffectivePermissionsState>(UNREAD);

  React.useEffect(() => {
    let cancelled = false;
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      let persisted: Set<Permission> | null;
      try {
        persisted = await readPersistedPermissions();
      } catch {
        // The device store could not be read. The last set read stays; a
        // first read still counts as read, with nothing saved, so a screen
        // that waits for it is never held and decides as before.
        if (!cancelled) {
          setState((prev) => (prev.read ? prev : { permissions: undefined, read: true }));
        }
        return;
      }
      if (cancelled) return;
      setState({
        permissions: persisted && persisted.size > 0 ? persisted : undefined,
        read: true,
      });
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      listeners.delete(reread);
    };
  }, []);

  return state;
}

export function useEffectivePermissions(): Set<Permission> | undefined {
  return useEffectivePermissionsState().permissions;
}

/** Nothing granted: what permissionsOnceRead gates with until the saved set is read. */
export const NO_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>();

/**
 * The set a screen gates with when it must never decide from the role's
 * static defaults while the saved set is still being read: nothing until it
 * is read, then the saved set, or undefined when nothing is saved (core `can`
 * then answers from the static defaults, as on every screen). Reading a
 * device store takes milliseconds and always ends (a failed read counts as
 * read), so nothing waits on it for long.
 */
export function permissionsOnceRead(
  state: EffectivePermissionsState,
): ReadonlySet<Permission> | undefined {
  return state.read ? state.permissions : NO_PERMISSIONS;
}
