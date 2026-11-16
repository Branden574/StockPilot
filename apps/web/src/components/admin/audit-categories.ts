// Plain data module — no 'use client'. Both the server page and the
// client filters import from here. Exporting AUDIT_CATEGORIES from
// audit-filters.tsx (which is 'use client') turned it into a client-
// reference; calling .find on a client-reference throws at runtime.
export interface AuditCategory {
  slug: string;
  label: string;
  /**
   * The event-name prefixes the chip lists (any of them). Empty for All
   * events, which filters nothing.
   */
  prefixes: readonly string[];
}

export const AUDIT_CATEGORIES: AuditCategory[] = [
  { slug: 'all', label: 'All events', prefixes: [] },
  { slug: 'stock', label: 'Stock', prefixes: ['stock.'] },
  { slug: 'inventory', label: 'Inventory', prefixes: ['inventory.'] },
  { slug: 'po', label: 'Purchase orders', prefixes: ['po_import.'] },
  { slug: 'cycle', label: 'Cycle counts', prefixes: ['cycle_count.'] },
  { slug: 'bundles', label: 'Bundles', prefixes: ['bundle.'] },
  // Team: the people side of the organization and its access (sign-ins,
  // passwords, sessions, roles, invitations), and the organization's API keys.
  { slug: 'user', label: 'Team', prefixes: ['user.', 'api_key.'] },
  { slug: 'warehouse', label: 'Warehouse', prefixes: ['warehouse'] },
];
