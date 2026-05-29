import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';

import { useAuth } from './auth-context';
import { supabase } from './supabase';

/**
 * Multi-org / multi-warehouse workspace state. Replaces the older
 * single-org assumption baked into `use-org.ts` by adding:
 *
 *   • full list of the user's accepted memberships (one per org),
 *   • the active org id, persisted under `workspace.activeOrgId`,
 *   • full list of warehouses the user can read in the active org,
 *   • the active warehouse id (or `null` for "all warehouses"),
 *     persisted under `workspace.activeWarehouseId.<orgId>`.
 *
 * Mirrors the web app's `/dashboard` top-bar warehouse dropdown +
 * org-context plumbing — pick once on the drawer header, every list
 * screen narrows to that warehouse until you switch again.
 *
 * Subscribers can call `setActiveOrg` / `setActiveWarehouse` from the
 * switcher sheet; this hook re-renders every consumer through the
 * shared module state below.
 */

export interface OrgOption {
  id: string;
  name: string;
  role: string;
}

export interface WarehouseOption {
  id: string;
  name: string;
}

interface WorkspaceState {
  loading: boolean;
  orgs: OrgOption[];
  activeOrgId: string | null;
  activeOrgName: string | null;
  activeRole: string | null;
  warehouses: WarehouseOption[];
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
}

const ORG_STORAGE_KEY = 'workspace.activeOrgId';
const WAREHOUSE_STORAGE_KEY = (orgId: string) => `workspace.activeWarehouseId.${orgId}`;

const listeners = new Set<(state: WorkspaceState) => void>();
let cached: WorkspaceState = {
  loading: true,
  orgs: [],
  activeOrgId: null,
  activeOrgName: null,
  activeRole: null,
  warehouses: [],
  activeWarehouseId: null,
  activeWarehouseName: null,
};

function publish(next: Partial<WorkspaceState>) {
  cached = { ...cached, ...next };
  for (const fn of listeners) fn(cached);
}

async function loadOrgs(userId: string) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organization_id, organizations:organization_id (name)')
    .eq('user_id', userId)
    .not('accepted_at', 'is', null);
  if (error) {
    console.warn('[workspace] loadOrgs failed:', error.message);
    return [] as OrgOption[];
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows
    .map((r) => {
      const orgField = r.organizations as { name?: string } | { name?: string }[] | null;
      const org = Array.isArray(orgField) ? orgField[0] : orgField;
      return {
        id: r.organization_id as string,
        name: (org?.name as string | undefined) ?? 'Workspace',
        role: r.role as string,
      };
    })
    .filter((o) => !!o.id);
}

async function loadWarehouses(orgId: string) {
  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, status')
    .eq('organization_id', orgId)
    .order('name', { ascending: true });
  if (error) {
    console.warn('[workspace] loadWarehouses failed:', error.message);
    return [] as WarehouseOption[];
  }
  return ((data ?? []) as Array<{ id: string; name: string; status?: string | null }>)
    .filter((w) => (w.status ?? 'active') !== 'archived')
    .map((w) => ({ id: w.id, name: w.name }));
}

async function hydrate(userId: string) {
  const orgs = await loadOrgs(userId);
  const persisted = await AsyncStorage.getItem(ORG_STORAGE_KEY);
  const activeOrgId =
    persisted && orgs.some((o) => o.id === persisted)
      ? persisted
      : orgs[0]?.id ?? null;
  let warehouses: WarehouseOption[] = [];
  let activeWarehouseId: string | null = null;
  if (activeOrgId) {
    warehouses = await loadWarehouses(activeOrgId);
    const persistedWh = await AsyncStorage.getItem(WAREHOUSE_STORAGE_KEY(activeOrgId));
    activeWarehouseId =
      persistedWh && warehouses.some((w) => w.id === persistedWh) ? persistedWh : null;
  }
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;
  publish({
    loading: false,
    orgs,
    activeOrgId,
    activeOrgName: activeOrg?.name ?? null,
    activeRole: activeOrg?.role ?? null,
    warehouses,
    activeWarehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
}

export async function setActiveOrg(orgId: string): Promise<void> {
  if (orgId === cached.activeOrgId) return;
  await AsyncStorage.setItem(ORG_STORAGE_KEY, orgId);
  const orgRow = cached.orgs.find((o) => o.id === orgId) ?? null;
  publish({
    activeOrgId: orgId,
    activeOrgName: orgRow?.name ?? null,
    activeRole: orgRow?.role ?? null,
    warehouses: [],
    activeWarehouseId: null,
    activeWarehouseName: null,
  });
  const warehouses = await loadWarehouses(orgId);
  const persistedWh = await AsyncStorage.getItem(WAREHOUSE_STORAGE_KEY(orgId));
  const activeWarehouseId =
    persistedWh && warehouses.some((w) => w.id === persistedWh) ? persistedWh : null;
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;
  publish({
    warehouses,
    activeWarehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
}

export async function setActiveWarehouse(warehouseId: string | null): Promise<void> {
  if (!cached.activeOrgId) return;
  const key = WAREHOUSE_STORAGE_KEY(cached.activeOrgId);
  if (warehouseId === null) {
    await AsyncStorage.removeItem(key);
  } else {
    await AsyncStorage.setItem(key, warehouseId);
  }
  const activeWarehouse = cached.warehouses.find((w) => w.id === warehouseId) ?? null;
  publish({
    activeWarehouseId: warehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
}

/**
 * React hook. Returns the live workspace state and triggers a hydrate
 * on first sign-in (or user-id change).
 */
export function useWorkspace(): WorkspaceState {
  const { user } = useAuth();
  const [state, setState] = React.useState<WorkspaceState>(cached);

  React.useEffect(() => {
    const fn = (next: WorkspaceState) => setState(next);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  React.useEffect(() => {
    if (!user) {
      publish({
        loading: false,
        orgs: [],
        activeOrgId: null,
        activeOrgName: null,
        activeRole: null,
        warehouses: [],
        activeWarehouseId: null,
        activeWarehouseName: null,
      });
      return;
    }
    publish({ loading: true });
    void hydrate(user.id);
  }, [user]);

  return state;
}
