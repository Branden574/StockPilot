import type { Permission } from '../constants/permissions';
import type { PlanId } from '../constants/plans';

/**
 * Module registry — the single declarative catalog of StockPilot modules.
 *
 * Each module carries entitlement metadata (tier, plan gating, domain-pack
 * defaults, dependencies, owned tables/api prefixes) plus its per-surface
 * navigation placements. Web + mobile navigation are intended to derive
 * from these placements so the rendered nav stays 1:1 with the registry.
 *
 * Placements were copied verbatim from the current static nav source files:
 *   - apps/web/src/components/dashboard/nav.ts        (BASE_NAV + ADMIN_NAV)
 *   - apps/mobile/src/lib/drawer-nav.ts               (DRAWER_SECTIONS)
 * Labels, hrefs, `requires` permissions, and lucide icon names are exact.
 */

export type ModuleTier = 'core' | 'optional' | 'premium';
export type NavSurface = 'web_sidebar' | 'mobile_drawer' | 'mobile_tab';
export type NavSectionKey = 'overview' | 'inventory' | 'workspace' | 'tools' | 'admin';
export type DomainPack =
  | 'charter_school'
  | 'distribution'
  | 'agriculture_food'
  | 'retail_backroom'
  | 'light_3pl';
export type ModuleId =
  | 'overview' | 'inventory' | 'movements' | 'categories' | 'locations'
  | 'reports' | 'notifications' | 'team' | 'settings' | 'admin_tools' | 'charters' | 'scan'
  | 'books' | 'rentals' | 'bundles' | 'orders' | 'cycle_counts' | 'procedures'
  | 'purchase_orders' | 'receiving' | 'po_imports' | 'suppliers' | 'schedule' | 'ai' | 'public_requests'
  | 'integrations' | 'shipping' | 'returns' | 'planning'
  | 'lot_serial' | 'reports_advanced' | 'ai_shelf_scan' | 'api_access' | 'price_tracking' | 'live_tracking' | 'zendesk';

export interface NavPlacement {
  surface: NavSurface;
  section: NavSectionKey;
  label: string;
  href: string;
  /** lucide icon name as a string (e.g. 'Boxes' on web, 'Box' on mobile). */
  iconName: string;
  defaultSortOrder: number;
  /** Permission required to show this placement. Omitted = everyone. */
  requires?: Permission;
  /** Stronger admin/owner gate; takes precedence over `requires`. */
  requiresAdmin?: boolean;
  /** True iff this placement should also surface as a mobile bottom tab. */
  mobileTabEligible?: boolean;
  badge?: string;
}

export interface ModuleDefinition {
  id: ModuleId;
  tier: ModuleTier;
  title: string;
  dependsOn: ModuleId[];
  /** Distinct permissions referenced by this module's placements. */
  permissions: Permission[];
  surfaces: ('web' | 'mobile' | 'api')[];
  apiPrefixes: string[];
  ownsTables: string[];
  /** Minimum plan required to enable a premium module. */
  minPlan?: PlanId;
  /** Domain packs that turn this module on by default (core is always on). */
  defaultOnFor: DomainPack[];
  placements: NavPlacement[];
}

export const MODULE_REGISTRY: Record<ModuleId, ModuleDefinition> = {
  // ── Core modules (always on, regardless of pack) ───────────────────────
  overview: {
    id: 'overview',
    tier: 'core',
    title: 'Overview',
    dependsOn: [],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'overview', label: 'Overview', href: '/dashboard', iconName: 'Home', defaultSortOrder: 0 },
      { surface: 'mobile_drawer', section: 'overview', label: 'Overview', href: '/', iconName: 'Home', defaultSortOrder: 0, mobileTabEligible: true },
    ],
  },
  inventory: {
    id: 'inventory',
    tier: 'core',
    title: 'Items',
    dependsOn: [],
    permissions: ['items:read', 'items:update'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/items', '/api/items'],
    ownsTables: ['items', 'item_variants', 'tags', 'item_tags'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Items', href: '/dashboard/inventory', iconName: 'Boxes', defaultSortOrder: 0, requires: 'items:read' },
      { surface: 'web_sidebar', section: 'inventory', label: 'Tags', href: '/dashboard/tags', iconName: 'Tags', defaultSortOrder: 40, requires: 'items:update' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Items', href: '/inventory', iconName: 'Box', defaultSortOrder: 0, mobileTabEligible: true },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Tags', href: '/tags', iconName: 'Tags', defaultSortOrder: 40 },
    ],
  },
  movements: {
    id: 'movements',
    tier: 'core',
    title: 'Movements',
    dependsOn: [],
    permissions: ['activity_logs:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['stock_movements'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Movements', href: '/dashboard/movements', iconName: 'ArrowLeftRight', defaultSortOrder: 50, requires: 'activity_logs:read' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Movements', href: '/movements', iconName: 'ArrowLeftRight', defaultSortOrder: 50 },
    ],
  },
  categories: {
    id: 'categories',
    tier: 'core',
    title: 'Categories',
    dependsOn: [],
    permissions: ['categories:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['categories'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Categories', href: '/dashboard/categories', iconName: 'Tag', defaultSortOrder: 30, requires: 'categories:read' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Categories', href: '/categories', iconName: 'Tag', defaultSortOrder: 30 },
    ],
  },
  locations: {
    id: 'locations',
    tier: 'core',
    title: 'Locations',
    dependsOn: [],
    permissions: ['locations:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['locations', 'warehouses', 'bins'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Locations', href: '/dashboard/locations', iconName: 'MapPin', defaultSortOrder: 130, requires: 'locations:read' },
      { surface: 'web_sidebar', section: 'admin', label: 'Warehouses', href: '/dashboard/admin/warehouses', iconName: 'Warehouse', defaultSortOrder: 20, requiresAdmin: true },
      { surface: 'web_sidebar', section: 'admin', label: 'Bins', href: '/dashboard/admin/bins', iconName: 'MapPin', defaultSortOrder: 30, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Locations', href: '/locations', iconName: 'MapPin', defaultSortOrder: 130 },
      { surface: 'mobile_drawer', section: 'admin', label: 'Warehouses', href: '/admin/warehouses', iconName: 'Warehouse', defaultSortOrder: 20, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Bins', href: '/admin/bins', iconName: 'MapPin', defaultSortOrder: 30, requiresAdmin: true },
    ],
  },
  reports: {
    id: 'reports',
    tier: 'core',
    title: 'Reports',
    dependsOn: [],
    permissions: ['reports:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Reports', href: '/dashboard/reports', iconName: 'BarChart3', defaultSortOrder: 150, requires: 'reports:read' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Reports', href: '/reports', iconName: 'BarChart3', defaultSortOrder: 150 },
    ],
  },
  notifications: {
    id: 'notifications',
    tier: 'core',
    title: 'Notifications',
    dependsOn: [],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['notifications'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Notifications', href: '/dashboard/notifications', iconName: 'Bell', defaultSortOrder: 20 },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Notifications', href: '/notifications', iconName: 'Bell', defaultSortOrder: 20 },
    ],
  },
  team: {
    id: 'team',
    tier: 'core',
    title: 'Team',
    dependsOn: [],
    permissions: ['members:invite'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['org_members', 'invitations'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Team', href: '/dashboard/team', iconName: 'Users', defaultSortOrder: 30, requires: 'members:invite' },
      { surface: 'web_sidebar', section: 'admin', label: 'Users', href: '/dashboard/admin/users', iconName: 'Users', defaultSortOrder: 40, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Team', href: '/team', iconName: 'Users', defaultSortOrder: 30 },
      { surface: 'mobile_drawer', section: 'admin', label: 'Users', href: '/admin/users', iconName: 'Users', defaultSortOrder: 40, requiresAdmin: true },
    ],
  },
  settings: {
    id: 'settings',
    tier: 'core',
    title: 'Settings',
    dependsOn: [],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['organizations'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Settings', href: '/dashboard/settings', iconName: 'Cog', defaultSortOrder: 40 },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Settings', href: '/settings', iconName: 'Cog', defaultSortOrder: 40 },
    ],
  },
  admin_tools: {
    id: 'admin_tools',
    tier: 'core',
    title: 'Admin tools',
    dependsOn: [],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['vendor_mappings', 'uom_conversions', 'audit_logs'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'admin', label: 'Admin overview', href: '/dashboard/admin', iconName: 'Network', defaultSortOrder: 0, requiresAdmin: true },
      { surface: 'web_sidebar', section: 'admin', label: 'Vendor mappings', href: '/dashboard/admin/vendor-mappings', iconName: 'BookOpen', defaultSortOrder: 50, requiresAdmin: true },
      { surface: 'web_sidebar', section: 'admin', label: 'UoM conversions', href: '/dashboard/admin/uom-conversions', iconName: 'ArrowLeftRight', defaultSortOrder: 60, requiresAdmin: true },
      { surface: 'web_sidebar', section: 'admin', label: 'Reconciliation', href: '/dashboard/admin/reconciliation', iconName: 'BarChart3', defaultSortOrder: 70, requiresAdmin: true },
      { surface: 'web_sidebar', section: 'admin', label: 'Audit log', href: '/dashboard/admin/audit', iconName: 'FileLock', defaultSortOrder: 80, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Admin overview', href: '/admin', iconName: 'Network', defaultSortOrder: 0, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Vendor mappings', href: '/admin/vendor-mappings', iconName: 'Layers', defaultSortOrder: 50, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'UoM conversions', href: '/admin/uom-conversions', iconName: 'ArrowLeftRight', defaultSortOrder: 60, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Reconciliation', href: '/admin/reconciliation', iconName: 'BarChart3', defaultSortOrder: 70, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Audit log', href: '/admin/audit', iconName: 'FileLock', defaultSortOrder: 80, requiresAdmin: true },
    ],
  },
  charters: {
    id: 'charters',
    tier: 'core',
    title: 'Charters',
    dependsOn: [],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['charters', 'warehouse_charters'],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'admin', label: 'Charters', href: '/dashboard/admin/charters', iconName: 'Building2', defaultSortOrder: 10, requiresAdmin: true },
      { surface: 'mobile_drawer', section: 'admin', label: 'Charters', href: '/admin/charters', iconName: 'Building2', defaultSortOrder: 10, requiresAdmin: true },
    ],
  },
  scan: {
    id: 'scan',
    tier: 'core',
    title: 'Scan',
    dependsOn: [],
    permissions: [],
    surfaces: ['mobile'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: [],
    placements: [
      { surface: 'mobile_drawer', section: 'tools', label: 'Scan', href: '/scan', iconName: 'ScanLine', defaultSortOrder: 0, mobileTabEligible: true },
    ],
  },

  // ── Optional modules (pack-driven defaults) ────────────────────────────
  books: {
    id: 'books',
    tier: 'optional',
    title: 'Books',
    dependsOn: ['inventory'],
    permissions: ['items:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Books', href: '/dashboard/books', iconName: 'BookOpen', defaultSortOrder: 20, requires: 'items:read' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Books', href: '/books', iconName: 'BookOpen', defaultSortOrder: 20, mobileTabEligible: true },
    ],
  },
  rentals: {
    id: 'rentals',
    tier: 'optional',
    title: 'Rentals',
    dependsOn: ['inventory'],
    permissions: ['rentals:create'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['rentals', 'rental_lines'],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Rentals', href: '/dashboard/rentals', iconName: 'PackageOpen', defaultSortOrder: 60, requires: 'rentals:create' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Rentals', href: '/rentals', iconName: 'PackageOpen', defaultSortOrder: 60 },
    ],
  },
  bundles: {
    id: 'bundles',
    tier: 'optional',
    title: 'Bundles',
    dependsOn: ['inventory'],
    permissions: ['bundles:distribute'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/bundles', '/api/bundles'],
    ownsTables: ['bundles', 'bundle_lines', 'bundle_distributions'],
    defaultOnFor: ['charter_school', 'distribution'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Bundles', href: '/dashboard/bundles', iconName: 'Package', defaultSortOrder: 70, requires: 'bundles:distribute' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Bundles', href: '/bundles', iconName: 'Package', defaultSortOrder: 70 },
    ],
  },
  orders: {
    id: 'orders',
    tier: 'optional',
    title: 'Orders',
    dependsOn: ['inventory'],
    permissions: ['orders:request'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/orders', '/api/orders'],
    ownsTables: ['order_requests', 'order_request_lines', 'stock_reservations'],
    defaultOnFor: ['charter_school', 'distribution', 'light_3pl'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Orders', href: '/dashboard/orders', iconName: 'ShoppingCart', defaultSortOrder: 80, requires: 'orders:request' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Orders', href: '/orders', iconName: 'ShoppingCart', defaultSortOrder: 80 },
    ],
  },
  cycle_counts: {
    id: 'cycle_counts',
    tier: 'optional',
    title: 'Cycle counts',
    dependsOn: ['inventory'],
    permissions: ['stock:adjust'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/cycle-counts'],
    ownsTables: ['cycle_counts', 'cycle_count_lines'],
    defaultOnFor: ['charter_school', 'distribution', 'agriculture_food', 'retail_backroom', 'light_3pl'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Cycle counts', href: '/dashboard/cycle-counts', iconName: 'ClipboardCheck', defaultSortOrder: 90, requires: 'stock:adjust' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Cycle counts', href: '/cycle-counts', iconName: 'ClipboardCheck', defaultSortOrder: 90 },
    ],
  },
  procedures: {
    id: 'procedures',
    tier: 'optional',
    title: 'Procedures',
    dependsOn: ['inventory'],
    permissions: ['items:update'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['procedures'],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Procedures', href: '/dashboard/procedures', iconName: 'BookOpen', defaultSortOrder: 100, requires: 'items:update' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Procedures', href: '/procedures', iconName: 'BookOpen', defaultSortOrder: 100 },
    ],
  },
  purchase_orders: {
    id: 'purchase_orders',
    tier: 'optional',
    title: 'Purchase orders',
    dependsOn: ['inventory'],
    permissions: ['purchase_orders:read'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/purchase-orders', '/api/purchase-orders'],
    ownsTables: ['purchase_orders', 'purchase_order_lines'],
    defaultOnFor: ['charter_school', 'distribution', 'agriculture_food', 'light_3pl'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Purchase orders', href: '/dashboard/purchase-orders', iconName: 'ClipboardList', defaultSortOrder: 110, requires: 'purchase_orders:read' },
      { surface: 'web_sidebar', section: 'inventory', label: 'Recurring POs', href: '/dashboard/purchase-orders/recurring', iconName: 'RefreshCw', defaultSortOrder: 111, requires: 'purchase_orders:manage' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Purchase orders', href: '/purchase-orders', iconName: 'ClipboardList', defaultSortOrder: 110 },
    ],
  },
  receiving: {
    id: 'receiving',
    tier: 'optional',
    title: 'Receiving',
    dependsOn: ['purchase_orders'],
    permissions: [],
    surfaces: ['mobile'],
    apiPrefixes: [],
    ownsTables: ['receipts', 'receipt_lines'],
    defaultOnFor: ['charter_school', 'distribution', 'agriculture_food', 'light_3pl'],
    placements: [
      // 105 keeps Receive POs between Procedures (100) and Purchase orders (110),
      // matching the mobile drawer's historical order. (receiving has no
      // web_sidebar placement, so the web sidebar is unaffected.)
      { surface: 'mobile_drawer', section: 'inventory', label: 'Receive POs', href: '/receive', iconName: 'Truck', defaultSortOrder: 105, mobileTabEligible: true },
    ],
  },
  po_imports: {
    id: 'po_imports',
    tier: 'optional',
    title: 'PO imports',
    dependsOn: ['purchase_orders'],
    permissions: ['purchase_orders:manage'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['po_imports'],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'PO imports', href: '/dashboard/purchase-orders/imports', iconName: 'Upload', defaultSortOrder: 120, requires: 'purchase_orders:manage' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'PO imports', href: '/po-imports', iconName: 'Upload', defaultSortOrder: 120 },
    ],
  },
  suppliers: {
    id: 'suppliers',
    tier: 'optional',
    title: 'Suppliers',
    dependsOn: ['inventory'],
    permissions: ['suppliers:read'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['suppliers'],
    defaultOnFor: ['charter_school', 'distribution', 'agriculture_food', 'light_3pl'],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Suppliers', href: '/dashboard/suppliers', iconName: 'Truck', defaultSortOrder: 140, requires: 'suppliers:read' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Suppliers', href: '/suppliers', iconName: 'Truck', defaultSortOrder: 140 },
    ],
  },
  schedule: {
    id: 'schedule',
    tier: 'optional',
    title: 'Schedule',
    dependsOn: ['inventory'],
    permissions: ['schedule:manage'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['schedule_events'],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Schedule', href: '/dashboard/schedule', iconName: 'Calendar', defaultSortOrder: 10, requires: 'schedule:manage' },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Schedule', href: '/schedule', iconName: 'Calendar', defaultSortOrder: 10 },
    ],
  },
  ai: {
    id: 'ai',
    tier: 'optional',
    title: 'AI Assistant',
    dependsOn: ['inventory'],
    permissions: ['items:update'],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/ai', '/api/ai'],
    ownsTables: [],
    defaultOnFor: ['charter_school'],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'AI Assistant', href: '/dashboard/ai', iconName: 'Sparkles', defaultSortOrder: 0, requires: 'items:update', badge: 'Beta' },
      { surface: 'web_sidebar', section: 'workspace', label: 'Briefing', href: '/dashboard/insights', iconName: 'Sparkles', defaultSortOrder: 1, requires: 'items:update', badge: 'New' },
      { surface: 'mobile_drawer', section: 'workspace', label: 'AI Assistant', href: '/ai', iconName: 'Sparkles', defaultSortOrder: 0 },
    ],
  },
  public_requests: {
    id: 'public_requests',
    tier: 'optional',
    title: 'Public requests',
    dependsOn: ['orders'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: ['/api/public/requests'],
    ownsTables: [],
    defaultOnFor: ['charter_school'],
    placements: [],
  },
  integrations: {
    id: 'integrations',
    tier: 'optional',
    title: 'Integrations',
    dependsOn: [],
    permissions: ['integrations:manage'],
    surfaces: ['api'],
    apiPrefixes: ['/api/integrations', '/api/cron/drain-outbox'],
    ownsTables: ['org_connections', 'connection_mappings', 'connection_sync_log'],
    // Net-new connector framework — OFF for every pack (incl. charter);
    // explicit opt-in only. Surfaced via the Integrations settings page,
    // not the main nav (no placements).
    defaultOnFor: [],
    placements: [],
  },
  shipping: {
    id: 'shipping',
    tier: 'optional',
    title: 'Shipping',
    dependsOn: [],
    permissions: ['shipping:manage'],
    surfaces: ['api'],
    // Only the EasyPost tracking webhook is exclusive to shipping. The order
    // shipping endpoints live under /api/v1/orders (shared with the orders
    // module) and are gated per-endpoint via assertModuleEnabled('shipping'),
    // so we deliberately do NOT list /api/v1/orders here to avoid clobbering
    // the orders module's prefix ownership.
    apiPrefixes: ['/api/webhooks/easypost'],
    ownsTables: ['carrier_shipments'],
    // Net-new carrier shipping — OFF for every pack (incl. charter); explicit
    // opt-in only. Surfaced via the Integrations settings page (EasyPost card),
    // not the main nav (no placements).
    defaultOnFor: [],
    placements: [],
  },
  returns: {
    id: 'returns',
    tier: 'optional',
    title: 'Returns',
    dependsOn: [],
    permissions: ['returns:manage'],
    surfaces: ['api'],
    apiPrefixes: ['/api/returns'],
    ownsTables: ['returns', 'return_lines'],
    // Net-new RMA / returns flow — OFF for every pack; explicit opt-in only.
    // Surfaced via its own /dashboard/returns staff UI (Phase A3). The sidebar
    // placement is module-derived: it only renders when the org has the
    // off-by-default `returns` module enabled AND the role holds
    // `returns:manage` (resolveSurface filters on both), mirroring how other
    // optional modules surface their nav. Sits just after Orders (80) in the
    // Inventory section.
    defaultOnFor: [],
    // Web-only for Phase A3 — there is no mobile /returns route yet, so we
    // deliberately add ONLY a web_sidebar placement (a mobile_drawer placement
    // would surface a dead nav link in the app).
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Returns', href: '/dashboard/returns', iconName: 'Undo2', defaultSortOrder: 85, requires: 'returns:manage' },
    ],
  },

  planning: {
    id: 'planning',
    tier: 'optional',
    title: 'Demand Planning',
    // Velocity-based reorder suggestions need both an item catalog
    // (velocity source + reorder params) and the PO module (auto-draft target).
    dependsOn: ['inventory', 'purchase_orders'],
    // Reuse the existing PO permission — planning is a buyer/manager surface,
    // not a new permission axis.
    permissions: ['purchase_orders:manage'],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: [],
    // On by default for the supply-heavy packs that buy to replenish.
    defaultOnFor: ['distribution', 'agriculture_food', 'light_3pl'],
    placements: [
      // Sits just below Purchase orders (110) in the Inventory section, ahead
      // of PO imports (120).
      { surface: 'web_sidebar', section: 'inventory', label: 'Reorder Planning', href: '/dashboard/planning', iconName: 'TrendingUp', defaultSortOrder: 115, requires: 'purchase_orders:manage' },
    ],
  },

  price_tracking: {
    id: 'price_tracking',
    tier: 'optional',
    title: 'Price monitoring',
    dependsOn: ['inventory'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: ['item_price_observations'],
    defaultOnFor: [],
    placements: [],
  },

  live_tracking: {
    id: 'live_tracking',
    tier: 'optional',
    title: 'Live tracking',
    dependsOn: ['orders'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: ['delivery_locations'],
    defaultOnFor: [],
    placements: [],
  },

  zendesk: {
    id: 'zendesk',
    tier: 'optional',
    title: 'Zendesk',
    dependsOn: [],
    permissions: ['integrations:manage'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Zendesk', href: '/dashboard/zendesk', iconName: 'Zendesk', defaultSortOrder: 900 },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Zendesk', href: '/zendesk', iconName: 'Zendesk', defaultSortOrder: 900 },
    ],
  },

  // ── Premium modules (plan-gated; no nav) ───────────────────────────────
  lot_serial: {
    id: 'lot_serial',
    tier: 'premium',
    title: 'Lot & serial tracking',
    dependsOn: ['inventory'],
    permissions: [],
    surfaces: ['web', 'mobile'],
    apiPrefixes: [],
    ownsTables: ['receipt_line_lots', 'serial_registry', 'lot_pick_events'],
    minPlan: 'business',
    defaultOnFor: ['agriculture_food'],
    placements: [],
  },
  reports_advanced: {
    id: 'reports_advanced',
    tier: 'premium',
    title: 'Advanced reports',
    dependsOn: ['reports'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: [],
    minPlan: 'business',
    defaultOnFor: [],
    placements: [],
  },
  ai_shelf_scan: {
    id: 'ai_shelf_scan',
    tier: 'premium',
    title: 'AI shelf scan',
    dependsOn: ['ai'],
    permissions: [],
    surfaces: ['mobile'],
    apiPrefixes: [],
    ownsTables: [],
    minPlan: 'business',
    defaultOnFor: ['charter_school'],
    placements: [],
  },
  api_access: {
    id: 'api_access',
    tier: 'premium',
    title: 'API access',
    dependsOn: [],
    permissions: [],
    surfaces: ['api'],
    apiPrefixes: ['/api/v1'],
    ownsTables: ['api_keys'],
    minPlan: 'enterprise',
    defaultOnFor: [],
    placements: [],
  },
};

/**
 * Modules enabled by default for a given domain pack: every core module
 * (always on) plus any optional/premium module that lists the pack in its
 * `defaultOnFor`.
 */
export function modulesForPack(pack: DomainPack): ModuleId[] {
  return (Object.values(MODULE_REGISTRY) as ModuleDefinition[])
    .filter((m) => m.tier === 'core' || m.defaultOnFor.includes(pack))
    .map((m) => m.id);
}

/** Default module set for a fresh org (charter-school pack). */
export const DEFAULT_MODULE_IDS: ModuleId[] = modulesForPack('charter_school');
