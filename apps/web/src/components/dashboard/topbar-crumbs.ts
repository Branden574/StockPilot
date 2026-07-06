/**
 * Breadcrumb derivation for the dashboard topbar.
 *
 * Pure data + functions (no React, no hooks) extracted from topbar.tsx so the
 * pathname→crumbs table and the per-org rename overlay are unit-testable
 * without rendering the Topbar.
 *
 * WHITE-LABEL RENAMES: orgs can rename sidebar items in Settings → Navigation
 * (`organizations.nav_overrides.labels`, keyed by the item's canonical HREF).
 * Every crumb below that corresponds to a sidebar nav item carries that same
 * canonical href, so `applyNavLabelsToCrumbs` can swap in the org's renamed
 * label. Section headers ("Inventory", "Workspace", "Admin") and sub-page
 * tails ("Edit", "Detail", "New", …) carry `href: null` and NEVER rename.
 */

export interface Crumb {
  label: string;
  /** When non-null, the segment renders as a clickable Link. The current
      page (last segment) and section labels with no canonical URL stay
      as plain text. */
  href: string | null;
}

const SECTION_INVENTORY: Crumb = { label: 'Inventory', href: null };
const SECTION_WORKSPACE: Crumb = { label: 'Workspace', href: null };
const SECTION_ADMIN: Crumb = { label: 'Admin', href: null };
const OVERVIEW: Crumb = { label: 'Overview', href: '/dashboard' };
const ITEMS_LIST: Crumb = { label: 'Items', href: '/dashboard/inventory' };
const BOOKS_LIST: Crumb = { label: 'Books', href: '/dashboard/books' };
const POS_LIST: Crumb = { label: 'Purchase orders', href: '/dashboard/purchase-orders' };
const PO_IMPORTS_LIST: Crumb = {
  label: 'PO imports',
  href: '/dashboard/purchase-orders/imports',
};
const CYCLE_COUNTS_LIST: Crumb = { label: 'Cycle counts', href: '/dashboard/cycle-counts' };
const BUNDLES_LIST: Crumb = { label: 'Bundles', href: '/dashboard/bundles' };
const ORDERS_LIST: Crumb = { label: 'Orders', href: '/dashboard/orders' };
const SCHEDULE_LIST: Crumb = { label: 'Schedule', href: '/dashboard/schedule' };
const SETTINGS_LIST: Crumb = { label: 'Settings', href: '/dashboard/settings' };

// NOTE ON TERMINAL CRUMBS: the LAST crumb always renders as plain text (the
// Topbar's `c.href && !isLast` check), so list pages reuse the *_LIST crumb —
// its href is only used for the rename lookup, never as a self-link.
const CRUMBS: Array<[RegExp, Crumb[]]> = [
  [/^\/dashboard$/, [OVERVIEW]],
  // /import must precede /[^/]+ so it isn't caught by the detail catch-all
  [/^\/dashboard\/inventory\/new$/, [SECTION_INVENTORY, ITEMS_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/inventory\/import$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Import', href: null }],
  ],
  [
    /^\/dashboard\/inventory\/[^/]+\/edit$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/inventory\/[^/]+$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/inventory$/, [SECTION_INVENTORY, ITEMS_LIST]],
  [/^\/dashboard\/books\/new$/, [SECTION_INVENTORY, BOOKS_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/books\/import$/,
    [SECTION_INVENTORY, BOOKS_LIST, { label: 'Import', href: null }],
  ],
  [
    /^\/dashboard\/books\/[^/]+\/edit$/,
    [SECTION_INVENTORY, BOOKS_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/books\/[^/]+$/,
    [SECTION_INVENTORY, BOOKS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/books$/, [SECTION_INVENTORY, BOOKS_LIST]],
  [
    /^\/dashboard\/categories$/,
    [SECTION_INVENTORY, { label: 'Categories', href: '/dashboard/categories' }],
  ],
  [
    /^\/dashboard\/movements$/,
    [SECTION_INVENTORY, { label: 'Movements', href: '/dashboard/movements' }],
  ],

  // Cycle counts
  [
    /^\/dashboard\/cycle-counts\/new$/,
    [SECTION_INVENTORY, CYCLE_COUNTS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/cycle-counts\/[^/]+$/,
    [SECTION_INVENTORY, CYCLE_COUNTS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/cycle-counts$/, [SECTION_INVENTORY, CYCLE_COUNTS_LIST]],

  // Bundles
  [/^\/dashboard\/bundles\/new$/, [SECTION_INVENTORY, BUNDLES_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/bundles\/[^/]+\/edit$/,
    [SECTION_INVENTORY, BUNDLES_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/bundles\/[^/]+$/,
    [SECTION_INVENTORY, BUNDLES_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/bundles$/, [SECTION_INVENTORY, BUNDLES_LIST]],

  // Orders (order requests). The /new and /[id]/print patterns MUST come
  // before the bare /[^/]+$ detail catch-all.
  [/^\/dashboard\/orders\/new$/, [SECTION_INVENTORY, ORDERS_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/orders\/[^/]+\/print$/,
    [SECTION_INVENTORY, ORDERS_LIST, { label: 'Print', href: null }],
  ],
  [
    /^\/dashboard\/orders\/[^/]+\/edit$/,
    [SECTION_INVENTORY, ORDERS_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/orders\/[^/]+$/,
    [SECTION_INVENTORY, ORDERS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/orders$/, [SECTION_INVENTORY, ORDERS_LIST]],

  // Purchase orders. Imports patterns MUST precede the bare /[^/]+$
  // detail pattern, otherwise "imports" matches as if it were a PO id.
  [
    /^\/dashboard\/purchase-orders\/new$/,
    [SECTION_INVENTORY, POS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/imports\/new$/,
    [SECTION_INVENTORY, POS_LIST, PO_IMPORTS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/imports\/[^/]+$/,
    [SECTION_INVENTORY, POS_LIST, PO_IMPORTS_LIST, { label: 'Detail', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/imports$/,
    [SECTION_INVENTORY, POS_LIST, PO_IMPORTS_LIST],
  ],
  [
    /^\/dashboard\/purchase-orders\/[^/]+$/,
    [SECTION_INVENTORY, POS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/purchase-orders$/, [SECTION_INVENTORY, POS_LIST]],

  [
    /^\/dashboard\/locations$/,
    [SECTION_INVENTORY, { label: 'Locations', href: '/dashboard/locations' }],
  ],
  [
    /^\/dashboard\/suppliers$/,
    [SECTION_INVENTORY, { label: 'Suppliers', href: '/dashboard/suppliers' }],
  ],
  [
    /^\/dashboard\/reports$/,
    [SECTION_INVENTORY, { label: 'Reports', href: '/dashboard/reports' }],
  ],

  // Workspace
  [/^\/dashboard\/ai$/, [SECTION_WORKSPACE, { label: 'AI Assistant', href: '/dashboard/ai' }]],
  [
    /^\/dashboard\/schedule\/new$/,
    [SECTION_WORKSPACE, SCHEDULE_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/schedule\/[^/]+\/edit$/,
    [SECTION_WORKSPACE, SCHEDULE_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/schedule\/[^/]+$/,
    [SECTION_WORKSPACE, SCHEDULE_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/schedule$/, [SECTION_WORKSPACE, SCHEDULE_LIST]],
  [
    /^\/dashboard\/notifications$/,
    [SECTION_WORKSPACE, { label: 'Notifications', href: '/dashboard/notifications' }],
  ],
  [/^\/dashboard\/team$/, [SECTION_WORKSPACE, { label: 'Team', href: '/dashboard/team' }]],
  [
    /^\/dashboard\/settings\/billing$/,
    [SECTION_WORKSPACE, SETTINGS_LIST, { label: 'Billing', href: null }],
  ],
  [
    /^\/dashboard\/settings\/public-requests$/,
    [SECTION_WORKSPACE, SETTINGS_LIST, { label: 'Public requests', href: null }],
  ],
  [/^\/dashboard\/settings$/, [SECTION_WORKSPACE, SETTINGS_LIST]],

  // Admin (all flat sub-routes; no list/detail nesting)
  [
    /^\/dashboard\/admin\/audit$/,
    [SECTION_ADMIN, { label: 'Audit log', href: '/dashboard/admin/audit' }],
  ],
  [/^\/dashboard\/admin\/bins$/, [SECTION_ADMIN, { label: 'Bins', href: '/dashboard/admin/bins' }]],
  [
    /^\/dashboard\/admin\/charters$/,
    [SECTION_ADMIN, { label: 'Charters', href: '/dashboard/admin/charters' }],
  ],
  [
    /^\/dashboard\/admin\/reconciliation$/,
    [SECTION_ADMIN, { label: 'Reconciliation', href: '/dashboard/admin/reconciliation' }],
  ],
  [
    /^\/dashboard\/admin\/uom-conversions$/,
    [SECTION_ADMIN, { label: 'UoM conversions', href: '/dashboard/admin/uom-conversions' }],
  ],
  [
    /^\/dashboard\/admin\/users$/,
    [SECTION_ADMIN, { label: 'Users', href: '/dashboard/admin/users' }],
  ],
  [
    /^\/dashboard\/admin\/vendor-mappings$/,
    [SECTION_ADMIN, { label: 'Vendor mappings', href: '/dashboard/admin/vendor-mappings' }],
  ],
  [
    /^\/dashboard\/admin\/warehouses$/,
    [SECTION_ADMIN, { label: 'Warehouses', href: '/dashboard/admin/warehouses' }],
  ],
  // Deliberately NO href: the crumb reads "Overview" but the registry's nav
  // label for /dashboard/admin is "Admin overview" — attaching the href would
  // silently change the default (un-renamed) crumb text.
  [/^\/dashboard\/admin$/, [SECTION_ADMIN, { label: 'Overview', href: null }]],
];

/** Static pathname → crumb-trail lookup. Unknown paths get an em-dash crumb. */
export function crumbsForPathname(pathname: string): Crumb[] {
  for (const [pattern, crumbs] of CRUMBS) {
    if (pattern.test(pathname)) return crumbs;
  }
  return [{ label: '—', href: null }];
}

/**
 * Flatten `navForRole` output (the org's OVERRIDDEN nav) into an
 * href → effective-label map for the crumb rename overlay. Structurally
 * typed so tests / callers don't need the icon-resolved NavItem shape.
 */
export function navLabelMap(
  sections: ReadonlyArray<{ items: ReadonlyArray<{ href: string; label: string }> }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    for (const item of section.items) map.set(item.href, item.label);
  }
  return map;
}

/**
 * Overlay the org's (possibly renamed) sidebar labels onto the static crumbs.
 * A crumb renames ONLY when its canonical href matches a nav item's href —
 * section headers and sub-page tails carry no href so their static label
 * always wins. An href absent from the map (item hidden, module off, link
 * permission-gated away, or no overrides at all) falls back to the static
 * label unchanged — fail-closed, mirroring `applyNavOverrides`.
 */
export function applyNavLabelsToCrumbs(
  crumbs: Crumb[],
  labelByHref: ReadonlyMap<string, string>,
): Crumb[] {
  return crumbs.map((c) => {
    const label = c.href ? labelByHref.get(c.href) : undefined;
    return label && label !== c.label ? { ...c, label } : c;
  });
}
