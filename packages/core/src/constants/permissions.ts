import type { Role } from './roles';

export const PERMISSIONS = [
  'organization:update',
  'billing:read',
  'billing:manage',
  'members:read',
  'members:invite',
  'members:remove',
  'members:update_role',
  'members:assign_categories',
  'rentals:create',
  'rentals:manage',
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
  'orders:assign_delivery',
  // Schedule events: manager+ creates/edits/deletes calendar entries.
  // Viewers can still read the calendar (RLS allows org members) but
  // can't mutate it. Without this gate, a viewer could call the
  // server actions directly and silently change anyone's events.
  'schedule:manage',
  // AI assistant configuration (embeddings backfill, model selection,
  // anything that burns external API quota). Admin-only so a manager
  // can't accidentally rerun a Gemini-heavy backfill across the whole
  // inventory. Used by /dashboard/settings/ai and the AI tile on
  // /dashboard/settings. Owners + admins.
  'ai:manage',
  // Connector integrations (QuickBooks Online export, future connectors).
  // Connect/disconnect a per-org connection + view sync health. Admin-only
  // (owner + admin via ALL_PERMISSIONS) because OAuth tokens grant external
  // accounting access; a manager must not be able to wire up or tear down
  // an export pipeline. Gated by the off-by-default `integrations` module.
  // Used by /dashboard/settings/integrations.
  'integrations:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== 'billing:manage'),
  manager: [
    'members:read',
    'members:assign_categories',
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
    'cycle_counts:assign',
    'bundles:manage',
    'bundles:distribute',
    'orders:request',
    'orders:approve',
    'orders:assign_delivery',
    'schedule:manage',
    'rentals:create',
    'rentals:manage',
  ],
  staff: [
    'members:read',
    'items:read',
    'items:create',
    'items:update',
    'items:import',
    'stock:adjust',
    'stock:transfer',
    'locations:read',
    'categories:read',
    'suppliers:read',
    'purchase_orders:read',
    'reports:read',
    'bundles:distribute',
    'orders:request',
    'rentals:create',
  ],
  viewer: [
    'members:read',
    'items:read',
    'locations:read',
    'categories:read',
    'suppliers:read',
    'purchase_orders:read',
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

/**
 * Human-readable metadata for each permission. Powers the
 * /dashboard/settings/roles reference page. Keep `group` consistent
 * inside a feature area — the page groups + sorts by it.
 */
export interface PermissionMeta {
  group: string;
  label: string;
  description: string;
}

export const PERMISSION_META: Record<Permission, PermissionMeta> = {
  'organization:update': {
    group: 'Organization',
    label: 'Edit organization details',
    description: 'Rename the workspace, change terminology labels.',
  },
  'billing:read': {
    group: 'Organization',
    label: 'View billing',
    description: 'See current plan, invoices, payment method.',
  },
  'billing:manage': {
    group: 'Organization',
    label: 'Manage billing',
    description: 'Change plan, update payment method, cancel subscription.',
  },
  'activity_logs:read': {
    group: 'Organization',
    label: 'View audit log',
    description: 'See every privileged action across the org.',
  },

  'members:read': {
    group: 'Members',
    label: 'View members',
    description: 'See who is in the workspace and their roles.',
  },
  'members:invite': {
    group: 'Members',
    label: 'Invite members',
    description: 'Send invitations to new users.',
  },
  'members:remove': {
    group: 'Members',
    label: 'Remove members',
    description: 'Revoke a member’s access.',
  },
  'members:update_role': {
    group: 'Members',
    label: 'Change member roles',
    description: 'Promote, demote, or reassign team members.',
  },
  'members:assign_categories': {
    group: 'Members',
    label: 'Restrict viewer category access',
    description:
      'Grant or revoke a viewer’s access to specific inventory categories.',
  },

  'items:read': {
    group: 'Items',
    label: 'View items',
    description: 'Browse the inventory list, books, item details.',
  },
  'items:create': {
    group: 'Items',
    label: 'Create items',
    description: 'Add new items (and sized variants) to inventory.',
  },
  'items:update': {
    group: 'Items',
    label: 'Edit items',
    description: 'Change item details, prices, rack, supplier.',
  },
  'items:delete': {
    group: 'Items',
    label: 'Delete items',
    description: 'Soft-delete items from inventory.',
  },
  'items:import': {
    group: 'Items',
    label: 'Import CSV',
    description: 'Bulk-create items from a CSV upload.',
  },
  'items:export': {
    group: 'Items',
    label: 'Export CSV',
    description: 'Download the inventory list as a CSV file.',
  },

  'stock:adjust': {
    group: 'Stock',
    label: 'Adjust on-hand',
    description: 'Add or remove stock with an audited movement.',
  },
  'stock:transfer': {
    group: 'Stock',
    label: 'Transfer stock',
    description: 'Move stock between locations or warehouses.',
  },

  'locations:read': {
    group: 'Locations',
    label: 'View locations',
    description: 'See the locations list.',
  },
  'locations:manage': {
    group: 'Locations',
    label: 'Manage locations',
    description: 'Create, rename, archive locations.',
  },

  'categories:read': {
    group: 'Categories',
    label: 'View categories',
    description: 'See the category list and assignments.',
  },
  'categories:manage': {
    group: 'Categories',
    label: 'Manage categories',
    description: 'Create, edit, archive categories. Flag size variants.',
  },

  'suppliers:read': {
    group: 'Suppliers',
    label: 'View suppliers',
    description: 'See the suppliers list.',
  },
  'suppliers:manage': {
    group: 'Suppliers',
    label: 'Manage suppliers',
    description: 'Create, edit, archive suppliers.',
  },

  'purchase_orders:read': {
    group: 'Purchase orders',
    label: 'View purchase orders',
    description: 'See draft, approved, in-transit, received POs.',
  },
  'purchase_orders:manage': {
    group: 'Purchase orders',
    label: 'Manage purchase orders',
    description: 'Create, approve, receive, and cancel POs.',
  },

  'reports:read': {
    group: 'Reports',
    label: 'View reports',
    description: 'Open the reports dashboard.',
  },
  'reports:export': {
    group: 'Reports',
    label: 'Export reports',
    description: 'Download reports as CSV or PDF.',
  },

  'cycle_counts:assign': {
    group: 'Cycle counts',
    label: 'Assign cycle counts',
    description: 'Route a cycle count to another team member.',
  },

  'bundles:manage': {
    group: 'Bundles',
    label: 'Manage bundles',
    description: 'Define and edit bundle (kit) recipes.',
  },
  'bundles:distribute': {
    group: 'Bundles',
    label: 'Distribute bundles',
    description: 'Run a bundle distribution (ship kits at events).',
  },

  'orders:request': {
    group: 'Order requests',
    label: 'Submit order requests',
    description: 'Submit a request for goods. Includes viewers.',
  },
  'orders:approve': {
    group: 'Order requests',
    label: 'Approve / fulfill orders',
    description: 'Approve, deny, ship, and mark delivered.',
  },
  'orders:assign_delivery': {
    group: 'Order requests',
    label: 'Assign deliveries',
    description: 'Assign a staged delivery to a driver. Manager+ only.',
  },

  'schedule:manage': {
    group: 'Schedule',
    label: 'Manage schedule',
    description: 'Create, edit, delete calendar entries.',
  },

  'ai:manage': {
    group: 'Organization',
    label: 'Manage AI assistant',
    description: 'Run semantic-search embeddings backfill and configure AI features.',
  },

  'integrations:manage': {
    group: 'Organization',
    label: 'Manage integrations',
    description: 'Connect, disconnect, and monitor connectors like QuickBooks Online.',
  },

  'rentals:create': {
    group: 'Rentals',
    label: 'Check items out and back in',
    description:
      'Create a rental (check out circulating assets like canopies) and mark them returned.',
  },
  'rentals:manage': {
    group: 'Rentals',
    label: 'Cancel and edit rentals',
    description:
      'Cancel an active rental, edit lines on an active rental. Manager+ only.',
  },
};

export const PERMISSION_GROUP_ORDER: ReadonlyArray<string> = [
  'Items',
  'Stock',
  'Locations',
  'Categories',
  'Suppliers',
  'Purchase orders',
  'Order requests',
  'Cycle counts',
  'Bundles',
  'Schedule',
  'Reports',
  'Members',
  'Organization',
];
