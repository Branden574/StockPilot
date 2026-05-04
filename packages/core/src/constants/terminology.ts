/**
 * Per-organization terminology. The DB row in `organizations.terminology`
 * (jsonb) overrides these defaults at runtime.
 */

import type { Role } from './roles';

export interface OrgTerminology {
  charter_singular: string;
  charter_plural: string;
  warehouse_singular: string;
  warehouse_plural: string;
}

export const DEFAULT_TERMINOLOGY: OrgTerminology = {
  charter_singular: 'Charter',
  charter_plural: 'Charters',
  warehouse_singular: 'Warehouse',
  warehouse_plural: 'Warehouses',
};

export function resolveTerminology(input: Partial<OrgTerminology> | null | undefined): OrgTerminology {
  return { ...DEFAULT_TERMINOLOGY, ...(input ?? {}) };
}

/**
 * User-facing role labels for the internal-company model.
 * The underlying DB role token is unchanged for stability.
 */
export interface RoleLabel {
  token: Role;
  label: string;
  description: string;
  isAdmin: boolean;
  isManager: boolean;
  /** True when the role is restricted to specific warehouses via assignments. */
  warehouseScoped: boolean;
}

export const ROLE_LABELS: Record<Role, RoleLabel> = {
  owner: {
    token: 'owner',
    label: 'Super Admin',
    description: 'Full system control. Owns the workspace.',
    isAdmin: true,
    isManager: true,
    warehouseScoped: false,
  },
  admin: {
    token: 'admin',
    label: 'Super Admin',
    description: 'Full system control.',
    isAdmin: true,
    isManager: true,
    warehouseScoped: false,
  },
  manager: {
    token: 'manager',
    label: 'Manager',
    description: 'Cross-warehouse view + management. Cannot change system settings.',
    isAdmin: false,
    isManager: true,
    warehouseScoped: false,
  },
  staff: {
    token: 'staff',
    label: 'Warehouse User',
    description: 'Manages inventory only for assigned warehouse(s).',
    isAdmin: false,
    isManager: false,
    warehouseScoped: true,
  },
  viewer: {
    token: 'viewer',
    label: 'Read-Only Auditor',
    description: 'View-only access to assigned warehouse(s).',
    isAdmin: false,
    isManager: false,
    warehouseScoped: true,
  },
};

/** Roles assignable when inviting from the admin UI (excludes implicit owner). */
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'manager', 'staff', 'viewer'];

export function isAdminRole(role: Role): boolean {
  return ROLE_LABELS[role].isAdmin;
}
export function isManagerOrAbove(role: Role): boolean {
  return ROLE_LABELS[role].isManager;
}
export function isWarehouseScoped(role: Role): boolean {
  return ROLE_LABELS[role].warehouseScoped;
}
