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
  // Cycle counts: most actions (start, record, post) gate on stock:adjust
  // because they emit stock_movements. ASSIGN is a manager+-only call so
  // a staff/viewer can't reroute work to someone else.
  'cycle_counts:assign',
  // Bundles: managers+ define and pre-assemble kit templates; staff+ run
  // distributions. Splitting the perms lets ops staff ship kits at events
  // without giving them write access to the kit recipe itself.
  'bundles:manage',
  'bundles:distribute',
  // Order requests: viewer+ can SUBMIT a request (the explicit fix that
  // unlocks read-only users for ordering). Manager+ can approve / deny /
  // change status / mark delivered / regenerate the public token.
  'orders:request',
  'orders:approve',
  // Schedule events: manager+ creates/edits/deletes calendar entries.
  // Viewers can still read the calendar (RLS allows org members) but
  // can't mutate it. Without this gate, a viewer could call the
  // server actions directly and silently change anyone's events.
  'schedule:manage',
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
    'cycle_counts:assign',
    'bundles:manage',
    'bundles:distribute',
    'orders:request',
    'orders:approve',
    'schedule:manage',
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
    'bundles:distribute',
    'orders:request',
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
    'orders:request',
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
