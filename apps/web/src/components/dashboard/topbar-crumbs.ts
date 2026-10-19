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
 * label. Section headers ("Inventory", "Fulfillment", "Purchasing",
 * "Insights", "Workspace", "Admin") and sub-page tails ("Edit", "Detail",
 * "New", …) carry `href: null` and NEVER rename.
 */

import { BOOK_REPORT_TITLE } from '@stockpilot/core';

export interface Crumb {
  label: string;
  /** When non-null, the segment renders as a clickable Link. The current
      page (last segment) and section labels with no canonical URL stay
      as plain text. */
  href: string | null;
}

// The sidebar's section headers (nav.ts SECTION_LABEL). Fulfillment,
// Purchasing and Insights are the owner's regroup of 2026-10-19.
const SECTION_INVENTORY: Crumb = { label: 'Inventory', href: null };
const SECTION_FULFILLMENT: Crumb = { label: 'Fulfillment', href: null };
const SECTION_PURCHASING: Crumb = { label: 'Purchasing', href: null };
const SECTION_INSIGHTS: Crumb = { label: 'Insights', href: null };
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
const EXCEPTIONS_LIST: Crumb = { label: 'Exceptions', href: '/dashboard/exceptions' };
const PRODUCT_GROUPS_LIST: Crumb = { label: 'Product groups', href: '/dashboard/product-groups' };
const RENTALS_LIST: Crumb = { label: 'Rentals', href: '/dashboard/rentals' };
// The Rentals page's Items tab. Not a sidebar item of its own, so it never renames.
const RENTAL_ITEMS_LIST: Crumb = { label: 'Items', href: '/dashboard/rentals/items' };
const RETURNS_LIST: Crumb = { label: 'Returns', href: '/dashboard/returns' };
const PROCEDURES_LIST: Crumb = { label: 'Procedures', href: '/dashboard/procedures' };
const REPORTS_LIST: Crumb = { label: 'Reports', href: '/dashboard/reports' };
const MAINTENANCE_LIST: Crumb = { label: 'Maintenance', href: '/dashboard/maintenance' };
const PUBLIC_REQUESTS_LIST: Crumb = {
  label: 'Public requests',
  href: '/dashboard/settings/public-requests',
};
// The parent of the admin sub-pages. Its href is the sidebar's Admin overview,
// so an org's rename of that item reaches this crumb too.
const ADMIN_OVERVIEW: Crumb = { label: 'Admin overview', href: '/dashboard/admin' };
const AUDIT_LOG: Crumb = { label: 'Audit log', href: '/dashboard/audit' };
const WAREHOUSES_LIST: Crumb = { label: 'Warehouses', href: '/dashboard/admin/warehouses' };

/** A last crumb that names the page and never renames (no canonical href). */
const tail = (label: string): Crumb => ({ label, href: null });

/**
 * Settings pages under the hub, by their path segment: the page's own heading
 * as the last crumb (Workspace / Settings / <page>).
 */
const SETTINGS_PAGES: Array<[string, string]> = [
  ['profile', 'Profile'],
  ['organization', 'Organization'],
  ['security', 'Security'],
  ['notifications', 'Notifications'],
  ['billing', 'Billing'],
  ['roles', 'Roles & permissions'],
  ['modules', 'Modules'],
  ['industry', 'Industry template'],
  ['navigation', 'Navigation'],
  ['dashboard', 'Dashboard'],
  ['custom-fields', 'Custom fields'],
  ['order-statuses', 'Order statuses'],
  ['public-requests', 'Public requests'],
  ['email-routing', 'Email routing'],
  ['ai', 'AI'],
  ['integrations', 'Integrations'],
  ['inventory-cleanup', 'Inventory cleanup'],
  ['recovery', 'Recovery'],
  ['restore-points', 'Backups & restore'],
  ['maintenance', 'Maintenance requests'],
];

/** Report pages under the hub, by their path segment: the report's own name. */
const REPORT_PAGES: Array<[string, string]> = [
  ['inventory-valuation', 'Inventory valuation'],
  ['stock-movements', 'Stock movement summary'],
  ['reorder-forecast', 'Reorder forecast'],
  ['shrinkage', 'Shrinkage & adjustments'],
  ['supplier-scorecard', 'Supplier scorecard'],
  ['velocity-class', 'Velocity classes (ABC)'],
  ['dead-stock', 'Dead stock'],
  ['bundle-activity', 'Bundle activity'],
  ['bundle-shortages', 'Bundle shortages'],
  ['item-cost-history', 'Item cost history'],
  ['book-order-totals', BOOK_REPORT_TITLE],
  ['lot-expiry', 'Aging & expiry'],
  ['lot-trace', 'Recall / lot trace'],
];

// NOTE ON TERMINAL CRUMBS: the LAST crumb always renders as plain text (the
// Topbar's `c.href && !isLast` check), so list pages reuse the *_LIST crumb —
// its href is only used for the rename lookup, never as a self-link.
//
// EVERY dashboard route has a trail (topbar-crumbs.test.ts walks the route
// folders and fails on an em dash). The section crumb is the sidebar section
// the page's nav item sits in; pages reached from a list sit under that list;
// a page that is no sidebar item and belongs to no section (What's new, Help)
// gets its own name alone. A record's own page keeps the generic tail
// ("Detail"): the page, not the bar, knows the record's name.
const CRUMBS: Array<[RegExp, Crumb[]]> = [
  [/^\/dashboard$/, [OVERVIEW]],
  // Release history. Not a sidebar item, so neither crumb can be renamed.
  [
    /^\/dashboard\/whats-new\/[^/]+$/,
    [
      { label: 'What’s new', href: '/dashboard/whats-new' },
      { label: 'Release', href: null },
    ],
  ],
  [/^\/dashboard\/whats-new$/, [{ label: 'What’s new', href: '/dashboard/whats-new' }]],
  // Help & Learning: the top bar's and the account menu's, not a sidebar item.
  [/^\/dashboard\/help$/, [{ label: 'Help & Learning', href: '/dashboard/help' }]],
  // /import must precede /[^/]+ so it isn't caught by the detail catch-all
  [/^\/dashboard\/inventory\/new$/, [SECTION_INVENTORY, ITEMS_LIST, { label: 'New', href: null }]],
  // Staging is a sidebar item of its own (the canonical href, so an org's
  // rename applies), and Labels a page of the Items list: both are fixed
  // paths the detail catch-all below would take for an item id.
  [
    /^\/dashboard\/inventory\/staging$/,
    [SECTION_INVENTORY, { label: 'Staging', href: '/dashboard/inventory/staging' }],
  ],
  [
    /^\/dashboard\/inventory\/labels$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Labels', href: null }],
  ],
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
  [/^\/dashboard\/books\/[^/]+$/, [SECTION_INVENTORY, BOOKS_LIST, { label: 'Detail', href: null }]],
  [/^\/dashboard\/books$/, [SECTION_INVENTORY, BOOKS_LIST]],

  // Exceptions: the list, then one occurrence.
  [/^\/dashboard\/exceptions\/[^/]+$/, [SECTION_INVENTORY, EXCEPTIONS_LIST, tail('Detail')]],
  [/^\/dashboard\/exceptions$/, [SECTION_INVENTORY, EXCEPTIONS_LIST]],

  // Product groups. /link (the family review, named as its heading names it)
  // precedes nothing it could clash with.
  [
    /^\/dashboard\/product-groups\/link$/,
    [SECTION_INVENTORY, PRODUCT_GROUPS_LIST, tail('Review product families')],
  ],
  [/^\/dashboard\/product-groups$/, [SECTION_INVENTORY, PRODUCT_GROUPS_LIST]],

  [
    /^\/dashboard\/categories$/,
    [SECTION_INVENTORY, { label: 'Categories', href: '/dashboard/categories' }],
  ],
  [/^\/dashboard\/tags$/, [SECTION_INVENTORY, { label: 'Tags', href: '/dashboard/tags' }]],
  [
    /^\/dashboard\/movements$/,
    [SECTION_INVENTORY, { label: 'Movements', href: '/dashboard/movements' }],
  ],

  // Rentals: the checkouts list and its Items tab, each with their own pages.
  // The fixed /new and /items paths precede the /[^/]+ detail catch-all.
  [/^\/dashboard\/rentals\/new$/, [SECTION_FULFILLMENT, RENTALS_LIST, tail('New')]],
  [
    /^\/dashboard\/rentals\/items\/new$/,
    [SECTION_FULFILLMENT, RENTALS_LIST, RENTAL_ITEMS_LIST, tail('New')],
  ],
  [
    /^\/dashboard\/rentals\/items\/[^/]+$/,
    [SECTION_FULFILLMENT, RENTALS_LIST, RENTAL_ITEMS_LIST, tail('Detail')],
  ],
  [/^\/dashboard\/rentals\/items$/, [SECTION_FULFILLMENT, RENTALS_LIST, RENTAL_ITEMS_LIST]],
  [/^\/dashboard\/rentals\/[^/]+$/, [SECTION_FULFILLMENT, RENTALS_LIST, tail('Detail')]],
  [/^\/dashboard\/rentals$/, [SECTION_FULFILLMENT, RENTALS_LIST]],

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
  [
    /^\/dashboard\/bundles\/new$/,
    [SECTION_FULFILLMENT, BUNDLES_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/bundles\/[^/]+\/edit$/,
    [SECTION_FULFILLMENT, BUNDLES_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/bundles\/[^/]+$/,
    [SECTION_FULFILLMENT, BUNDLES_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/bundles$/, [SECTION_FULFILLMENT, BUNDLES_LIST]],

  // Orders (order requests). The /new and /[id]/print patterns MUST come
  // before the bare /[^/]+$ detail catch-all.
  [/^\/dashboard\/orders\/new$/, [SECTION_FULFILLMENT, ORDERS_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/orders\/[^/]+\/print$/,
    [SECTION_FULFILLMENT, ORDERS_LIST, { label: 'Print', href: null }],
  ],
  // The pick slip of one order.
  [/^\/dashboard\/orders\/[^/]+\/pick$/, [SECTION_FULFILLMENT, ORDERS_LIST, tail('Pick')]],
  [
    /^\/dashboard\/orders\/[^/]+\/edit$/,
    [SECTION_FULFILLMENT, ORDERS_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/orders\/[^/]+$/,
    [SECTION_FULFILLMENT, ORDERS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/orders$/, [SECTION_FULFILLMENT, ORDERS_LIST]],

  // Returns: the list, then one return's workbench.
  [/^\/dashboard\/returns\/[^/]+$/, [SECTION_FULFILLMENT, RETURNS_LIST, tail('Detail')]],
  [/^\/dashboard\/returns$/, [SECTION_FULFILLMENT, RETURNS_LIST]],

  // Procedures. /new precedes the /[^/]+ detail catch-all.
  [/^\/dashboard\/procedures\/new$/, [SECTION_INVENTORY, PROCEDURES_LIST, tail('New')]],
  [/^\/dashboard\/procedures\/[^/]+\/edit$/, [SECTION_INVENTORY, PROCEDURES_LIST, tail('Edit')]],
  [/^\/dashboard\/procedures\/[^/]+$/, [SECTION_INVENTORY, PROCEDURES_LIST, tail('Detail')]],
  [/^\/dashboard\/procedures$/, [SECTION_INVENTORY, PROCEDURES_LIST]],

  // Purchase orders. Imports patterns MUST precede the bare /[^/]+$
  // detail pattern, otherwise "imports" matches as if it were a PO id.
  [
    /^\/dashboard\/purchase-orders\/new$/,
    [SECTION_PURCHASING, POS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/recurring$/,
    [SECTION_PURCHASING, POS_LIST, { label: 'Recurring', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/imports\/new$/,
    [SECTION_PURCHASING, POS_LIST, PO_IMPORTS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/imports\/[^/]+$/,
    [SECTION_PURCHASING, POS_LIST, PO_IMPORTS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/purchase-orders\/imports$/, [SECTION_PURCHASING, POS_LIST, PO_IMPORTS_LIST]],
  [/^\/dashboard\/purchase-orders\/[^/]+\/edit$/, [SECTION_PURCHASING, POS_LIST, tail('Edit')]],
  [
    /^\/dashboard\/purchase-orders\/[^/]+$/,
    [SECTION_PURCHASING, POS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/purchase-orders$/, [SECTION_PURCHASING, POS_LIST]],
  [
    /^\/dashboard\/planning$/,
    [SECTION_PURCHASING, { label: 'Reorder Planning', href: '/dashboard/planning' }],
  ],

  // One location's page (F1-3).
  [
    /^\/dashboard\/locations\/[^/]+$/,
    [
      SECTION_INVENTORY,
      { label: 'Locations', href: '/dashboard/locations' },
      { label: 'Detail', href: null },
    ],
  ],
  [
    /^\/dashboard\/locations$/,
    [SECTION_INVENTORY, { label: 'Locations', href: '/dashboard/locations' }],
  ],
  [
    /^\/dashboard\/suppliers$/,
    [SECTION_PURCHASING, { label: 'Suppliers', href: '/dashboard/suppliers' }],
  ],

  // Insights. Reports: the hub, then each report under it by its own name.
  ...REPORT_PAGES.map(([segment, label]): [RegExp, Crumb[]] => [
    new RegExp(`^/dashboard/reports/${segment}$`),
    [SECTION_INSIGHTS, REPORTS_LIST, tail(label)],
  ]),
  [/^\/dashboard\/reports$/, [SECTION_INSIGHTS, REPORTS_LIST]],
  [/^\/dashboard\/ai$/, [SECTION_INSIGHTS, { label: 'AI Assistant', href: '/dashboard/ai' }]],
  // The Briefing page's route is /dashboard/insights; its section is Insights too.
  [
    /^\/dashboard\/insights$/,
    [SECTION_INSIGHTS, { label: 'Briefing', href: '/dashboard/insights' }],
  ],

  // Workspace
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
  [/^\/dashboard\/support$/, [SECTION_WORKSPACE, { label: 'Support', href: '/dashboard/support' }]],
  [
    /^\/dashboard\/customers$/,
    [SECTION_WORKSPACE, { label: 'Accounts', href: '/dashboard/customers' }],
  ],
  // Maintenance requests. /new precedes the /[^/]+ detail catch-all.
  [/^\/dashboard\/maintenance\/new$/, [SECTION_WORKSPACE, MAINTENANCE_LIST, tail('New')]],
  [/^\/dashboard\/maintenance\/[^/]+$/, [SECTION_WORKSPACE, MAINTENANCE_LIST, tail('Detail')]],
  [/^\/dashboard\/maintenance$/, [SECTION_WORKSPACE, MAINTENANCE_LIST]],
  [/^\/dashboard\/zendesk$/, [SECTION_WORKSPACE, { label: 'Zendesk', href: '/dashboard/zendesk' }]],

  // Settings: the hub, then every page under it. One public request link
  // sits under the Public requests page.
  [
    /^\/dashboard\/settings\/public-requests\/[^/]+$/,
    [SECTION_WORKSPACE, SETTINGS_LIST, PUBLIC_REQUESTS_LIST, tail('Detail')],
  ],
  [
    /^\/dashboard\/settings\/migrate\/sage50$/,
    [SECTION_WORKSPACE, SETTINGS_LIST, tail('Migrate from Sage 50')],
  ],
  // The old settings audit page forwards to the audit console: the trail of
  // the page it lands on.
  [/^\/dashboard\/settings\/audit$/, [SECTION_ADMIN, AUDIT_LOG]],
  ...SETTINGS_PAGES.map(([segment, label]): [RegExp, Crumb[]] => [
    new RegExp(`^/dashboard/settings/${segment}$`),
    [SECTION_WORKSPACE, SETTINGS_LIST, tail(label)],
  ]),
  [/^\/dashboard\/settings$/, [SECTION_WORKSPACE, SETTINGS_LIST]],

  // Admin (all flat sub-routes; no list/detail nesting). The audit console
  // lives at /dashboard/audit (grantable, outside the admin layout) but
  // stays under the Admin crumb section to match its sidebar placement.
  [/^\/dashboard\/audit$/, [SECTION_ADMIN, AUDIT_LOG]],
  // The old admin audit page forwards to the audit console.
  [/^\/dashboard\/admin\/audit$/, [SECTION_ADMIN, AUDIT_LOG]],
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
  [/^\/dashboard\/admin\/warehouses$/, [SECTION_ADMIN, WAREHOUSES_LIST]],
  // Pages reached from the admin overview, under it (each page's own back
  // link goes there too).
  [/^\/dashboard\/admin\/orgs\/new$/, [SECTION_ADMIN, ADMIN_OVERVIEW, tail('New organization')]],
  [/^\/dashboard\/admin\/support$/, [SECTION_ADMIN, ADMIN_OVERVIEW, tail('Support tickets')]],
  // One warehouse's page, reached from the admin Warehouses list (its own
  // back link returns there).
  [/^\/dashboard\/warehouses\/[^/]+$/, [SECTION_ADMIN, WAREHOUSES_LIST, tail('Detail')]],
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
