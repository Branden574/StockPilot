import * as React from 'react';

import { getMeta } from './db';

/**
 * Source of truth for the current user's WAREHOUSE SCOPE on mobile — the
 * snapshot endpoint's `warehouseScope { hasAllAccess, warehouseNames }`
 * (computed server-side from role + user_warehouse_assignments), persisted by
 * sync.ts under this meta key on every pull, exactly like enabled-modules and
 * effective-permissions.
 *
 * The Items screen renders the scoped-view banner from this (web parity with
 * ScopedWarehouseNotice): a staff/viewer narrowed to assigned warehouses sees
 * WHICH warehouses they're looking at instead of silently-missing inventory.
 *
 * Default-while-loading is `undefined` → no banner until a snapshot has
 * persisted a real value (never a flash of "no assigned warehouses" on a
 * fresh install). Display-only: the API + RLS enforce the actual scoping
 * server-side, this just explains it.
 */
export const WAREHOUSE_SCOPE_META_KEY = 'warehouse_scope';

export interface WarehouseScope {
  /** True for owner/admin/manager — every warehouse. */
  hasAllAccess: boolean;
  /** Names of the warehouses a scoped user can read ([] = none assigned). */
  warehouseNames: string[];
}

/** Parse a persisted (or wire) value. Null on missing/garbage — callers
 *  treat that as "not loaded yet" and render nothing. Pure + tested. */
export function parseWarehouseScope(raw: string | null): WarehouseScope | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const o = v as { hasAllAccess?: unknown; warehouseNames?: unknown };
    if (typeof o.hasAllAccess !== 'boolean') return null;
    const names = Array.isArray(o.warehouseNames)
      ? o.warehouseNames.filter((n): n is string => typeof n === 'string')
      : [];
    return { hasAllAccess: o.hasAllAccess, warehouseNames: names };
  } catch {
    return null;
  }
}

/**
 * The scoped-view banner line, or null when there is nothing to explain
 * (all-access, or scope not loaded yet). Copy mirrors the web
 * scopedWarehouseMessage verbatim — keep the two in lockstep. Pure + tested.
 */
export function warehouseScopeMessage(scope: WarehouseScope | null | undefined): string | null {
  if (!scope || scope.hasAllAccess) return null;
  if (scope.warehouseNames.length === 0) {
    return 'You have no assigned warehouses. An admin can adjust warehouse access from the Team page.';
  }
  return `You're viewing ${scope.warehouseNames.join(', ')} only. An admin can adjust warehouse access from the Team page.`;
}

export async function readPersistedWarehouseScope(): Promise<WarehouseScope | null> {
  return parseWarehouseScope(await getMeta(WAREHOUSE_SCOPE_META_KEY));
}

const listeners = new Set<() => void>();

/** Notify active useWarehouseScope() hooks to re-read the persisted scope. */
export function refreshWarehouseScope(): void {
  for (const fn of listeners) fn();
}

/** Current warehouse scope; `undefined` until a snapshot has persisted one. */
export function useWarehouseScope(): WarehouseScope | undefined {
  const [scope, setScope] = React.useState<WarehouseScope | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      const persisted = await readPersistedWarehouseScope();
      if (cancelled) return;
      setScope(persisted ?? undefined);
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      listeners.delete(reread);
    };
  }, []);

  return scope;
}
