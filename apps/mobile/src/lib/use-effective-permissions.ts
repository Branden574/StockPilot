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

export function useEffectivePermissions(): Set<Permission> | undefined {
  const [perms, setPerms] = React.useState<Set<Permission> | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      const persisted = await readPersistedPermissions();
      if (cancelled) return;
      setPerms(persisted && persisted.size > 0 ? persisted : undefined);
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      listeners.delete(reread);
    };
  }, []);

  return perms;
}
