import type { Role } from './roles';

export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'organization:delete',
  'billing:read',
  'billing:manage',
  'members:read',
  'members:invite',
  'members:remove',
  'members:update_role',
  'items:read',
  'items:create',
  'items:update',
  'items:delete',
  'items:import',
  'items:export',
  'stock:adjust',
  'stock:transfer',
  'locations:read',
  'locations:manage',
  'categories:read',
  'categories:manage',
  'suppliers:read',
  'suppliers:manage',
  'purchase_orders:read',
  'purchase_orders:manage',
  'reports:read',
  'reports:export',
  'activity_logs:read',
  'settings:read',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter(
    (p) => p !== 'organization:delete' && p !== 'billing:manage',
  ),
  manager: [
    'organization:read',
    'members:read',
    'items:read',
    'items:create',
    'items:update',
    'items:import',
    'items:export',
    'stock:adjust',
    'stock:transfer',
    'locations:read',
    'locations:manage',
    'categories:read',
    'categories:manage',
    'suppliers:read',
    'suppliers:manage',
    'purchase_orders:read',
    'purchase_orders:manage',
    'reports:read',
    'reports:export',
    'activity_logs:read',
    'settings:read',
  ],
  staff: [
    'organization:read',
    'members:read',
    'items:read',
    'items:create',
    'items:update',
    'stock:adjust',
    'stock:transfer',
    'locations:read',
    'categories:read',
    'suppliers:read',
    'purchase_orders:read',
    'reports:read',
  ],
  viewer: [
    'organization:read',
    'members:read',
    'items:read',
    'locations:read',
    'categories:read',
    'suppliers:read',
    'purchase_orders:read',
    'reports:read',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission denied: ${role} cannot ${permission}`);
  }
}
