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
 * narrows/widens per overrides — never an empty flash. An empty saved set is
 * a saved set: a member who holds no permission (S75). Both writers save a
 * list only when the server sent one, and the server refuses a request whose
 * permissions it cannot read rather than send none.
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

const listeners = new Set<() => Promise<void>>();

/**
 * Notify active useEffectivePermissions() hooks to re-read the persisted set.
 * Resolves once every one has read it (a workspace switch waits for that
 * before it shows the new workspace); never rejects.
 */
export function refreshEffectivePermissions(): Promise<void> {
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
export function rereadFailedEffectivePermissions(): Promise<void> {
  return Promise.all([...failedReads].map((fn) => fn().catch(() => undefined))).then(
    () => undefined,
  );
}

/**
 * Light fetch of the effective permission set → persist + notify. Used by the
 * realtime subscription (and on demand). Fail-silent: a failed fetch leaves the
 * last persisted set in place rather than blanking the nav.
 */
export async function fetchEffectivePermissions(): Promise<void> {
  try {
    const res = await api<{ role: Role; permissions: string[] }>('/api/v1/me/permissions');
    // Only a list the server sent is saved: an empty saved set is a member
    // who holds no permission, never "not known".
    if (!Array.isArray(res.permissions)) return;
    const next = JSON.stringify(res.permissions);
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
  /** The saved set has been read once: found, absent or unreadable, or not
   *  answered within SAVED_PERMISSIONS_READ_WAIT_MS. Until then an undefined
   *  `permissions` means "not read yet", not "nothing saved". Never goes
   *  back to false. */
  read: boolean;
  /** The device store has answered a read: true when it came back (found,
   *  absent or unparseable), 'failed' when the latest read threw (a first
   *  read or a re-read: a re-read asked for after a workspace switch that
   *  throws must not let the previous answer stand). Never set by the wait:
   *  false until a read answers, however long it takes. A screen deciding
   *  what it reads or shows by the saved set uses this alone
   *  (screen-access.ts), so it never decides from the static defaults the
   *  wait falls back to. */
  answered: boolean | 'failed';
}

const UNREAD: EffectivePermissionsState = {
  permissions: undefined,
  read: false,
  answered: false,
};

/**
 * How long a screen waits for the first read of the saved set. Reading the
 * device store takes milliseconds; one that has not answered by then (its
 * open or a migration stalled) counts as read with nothing saved, so the
 * static defaults decide, as before, and the set still replaces them when it
 * lands. Without it the order screen, which waits for the read, kept its
 * spinner up for good with no Try again (review of the S2 follow-up, F5).
 */
export const SAVED_PERMISSIONS_READ_WAIT_MS = 2000;

/** Read, by the wait or a read that threw, with nothing saved and nothing
 *  answered: the static defaults decide where `read` is enough. */
const READ_NOTHING_SAVED: EffectivePermissionsState = {
  permissions: undefined,
  read: true,
  answered: false,
};

export function useEffectivePermissionsState(): EffectivePermissionsState {
  const [state, setState] = React.useState<EffectivePermissionsState>(UNREAD);

  React.useEffect(() => {
    let cancelled = false;
    // The first read counts as done after the wait, whatever it is doing; a
    // read that settles first clears it.
    let wait: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      wait = null;
      if (!cancelled) setState((prev) => (prev.read ? prev : READ_NOTHING_SAVED));
    }, SAVED_PERMISSIONS_READ_WAIT_MS);
    const stopWaiting = (): void => {
      if (wait !== null) clearTimeout(wait);
      wait = null;
    };
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      let persisted: Set<Permission> | null;
      try {
        persisted = await readPersistedPermissions();
      } catch {
        // The device store could not be read. The last set read stays for
        // the menu; a first read still counts as read, with nothing saved, so
        // the order screen is never held. For a screen gated on the saved set
        // the read failed (it offers Try again), whatever was answered before.
        stopWaiting();
        if (!cancelled) {
          failedReads.add(reread);
          setState((prev) => ({ ...(prev.read ? prev : READ_NOTHING_SAVED), answered: 'failed' }));
        }
        return;
      }
      stopWaiting();
      failedReads.delete(reread);
      if (cancelled) return;
      // A saved set, empty included, is the member's answer: only a pull and
      // fetchEffectivePermissions write the key, each only with a list the
      // server sent (sync.ts, above).
      setState({
        permissions: persisted ?? undefined,
        read: true,
        answered: true,
      });
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
 * read, and so does one still not answered after
 * SAVED_PERMISSIONS_READ_WAIT_MS), so nothing waits on it for long.
 */
export function permissionsOnceRead(
  state: Pick<EffectivePermissionsState, 'permissions' | 'read'>,
): ReadonlySet<Permission> | undefined {
  return state.read ? state.permissions : NO_PERMISSIONS;
}
