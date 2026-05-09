// Plain data module — no 'use client'. Both the server page and the
// client filters import from here. Exporting AUDIT_CATEGORIES from
// audit-filters.tsx (which is 'use client') turned it into a client-
// reference; calling .find on a client-reference throws at runtime.
export interface AuditCategory {
  slug: string;
  label: string;
  prefix: string | null;
}

export const AUDIT_CATEGORIES: AuditCategory[] = [
  { slug: 'all', label: 'All events', prefix: null },
  { slug: 'stock', label: 'Stock', prefix: 'stock.' },
  { slug: 'inventory', label: 'Inventory', prefix: 'inventory.' },
  { slug: 'po', label: 'Purchase orders', prefix: 'po_import.' },
  { slug: 'cycle', label: 'Cycle counts', prefix: 'cycle_count.' },
  { slug: 'bundles', label: 'Bundles', prefix: 'bundle.' },
  { slug: 'user', label: 'Team', prefix: 'user.' },
  { slug: 'warehouse', label: 'Warehouse', prefix: 'warehouse' },
];
