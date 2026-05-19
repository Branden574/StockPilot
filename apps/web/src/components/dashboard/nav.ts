import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Bell,
  Boxes,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  Cog,
  FileLock,
  Home,
  type LucideIcon,
  MapPin,
  Network,
  Package,
  PackageOpen,
  Send,
  ShoppingCart,
  Sparkles,
  Tag,
  Tags,
  Truck,
  Upload,
  Users,
  Warehouse,
} from 'lucide-react';

import type { Permission, Role } from '@stockpilot/core';
import { hasPermission, isAdminRole } from '@stockpilot/core';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string | number;
  alert?: boolean;
  /**
   * Permission required to see this nav entry. Omitted = everyone
   * (Overview, Notifications, Settings, your own Profile, etc.).
   * `requiresAdmin` is the stronger admin/owner gate; takes precedence.
   */
  requires?: Permission;
  requiresAdmin?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

// Base nav — every role sees the section headers, but each item is
// individually permission-gated by navForRole() below. A viewer ends
// up with a much shorter list than a manager / admin.
const BASE_NAV: NavSection[] = [
  {
    items: [{ href: '/dashboard', label: 'Overview', icon: Home }],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Items', icon: Boxes, requires: 'items:read' },
      { href: '/dashboard/books', label: 'Books', icon: BookOpen, requires: 'items:read' },
      { href: '/dashboard/categories', label: 'Categories', icon: Tag, requires: 'categories:read' },
      // Tags / Movements / Bundles / Shipments / Cycle counts / Procedures
      // / PO imports are all writer-or-better surfaces — viewer doesn't
      // get them. Tags has no dedicated permission so we ride on the
      // closest writer perm (items:update). Movements ride on
      // activity_logs:read (managers+ only).
      { href: '/dashboard/tags', label: 'Tags', icon: Tags, requires: 'items:update' },
      { href: '/dashboard/movements', label: 'Movements', icon: ArrowLeftRight, requires: 'activity_logs:read' },
      // Rentals: circulating-asset checkout/return for staff (canopies,
      // supplies). Staff+ creates rentals via rentals:create. The Rentals
      // section itself is two-tab: Activity (transactions) + Items
      // (rental catalog).
      { href: '/dashboard/rentals', label: 'Rentals', icon: PackageOpen, requires: 'rentals:create' },
      { href: '/dashboard/bundles', label: 'Bundles', icon: Package, requires: 'bundles:distribute' },
      { href: '/dashboard/orders', label: 'Orders', icon: ShoppingCart, requires: 'orders:request' },
      { href: '/dashboard/shipments', label: 'Shipments (Archive)', icon: Send, requires: 'purchase_orders:manage' },
      { href: '/dashboard/cycle-counts', label: 'Cycle counts', icon: ClipboardCheck, requires: 'stock:adjust' },
      { href: '/dashboard/procedures', label: 'Procedures', icon: BookOpen, requires: 'items:update' },
      { href: '/dashboard/purchase-orders', label: 'Purchase orders', icon: ClipboardList, requires: 'purchase_orders:read' },
      { href: '/dashboard/purchase-orders/imports', label: 'PO imports', icon: Upload, requires: 'purchase_orders:manage' },
      { href: '/dashboard/locations', label: 'Locations', icon: MapPin, requires: 'locations:read' },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck, requires: 'suppliers:read' },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3, requires: 'reports:read' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      // AI Assistant + Schedule are write-ish surfaces. Viewers don't get
      // them (Schedule create/edit gates on schedule:manage; AI tool calls
      // are gated server-side by the underlying service permissions but
      // exposing the surface to a viewer is confusing).
      { href: '/dashboard/ai', label: 'AI Assistant', icon: Sparkles, badge: 'Beta', requires: 'items:update' },
      { href: '/dashboard/schedule', label: 'Schedule', icon: Calendar, requires: 'schedule:manage' },
      // Notifications + Team + Settings — every authenticated org member
      // sees their own notifications, the team roster (members:read), and
      // their own profile/settings.
      { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
      // Viewers can technically read members via members:read, but the
      // team page loads pending invites which require members:invite —
      // and viewers have no manage actions there anyway. Gate the nav
      // entry on the stronger permission so viewers don't see a button
      // that lands on a forbidden page. Direct-URL access is blocked
      // server-side at apps/web/src/app/(dashboard)/dashboard/team/page.tsx.
      { href: '/dashboard/team', label: 'Team', icon: Users, requires: 'members:invite' },
      { href: '/dashboard/settings', label: 'Settings', icon: Cog },
    ],
  },
];

const ADMIN_NAV: NavSection = {
  label: 'Admin',
  items: [
    { href: '/dashboard/admin', label: 'Admin overview', icon: Network, requiresAdmin: true },
    { href: '/dashboard/admin/charters', label: 'Charters', icon: Building2, requiresAdmin: true },
    { href: '/dashboard/admin/warehouses', label: 'Warehouses', icon: Warehouse, requiresAdmin: true },
    { href: '/dashboard/admin/bins', label: 'Bins', icon: MapPin, requiresAdmin: true },
    { href: '/dashboard/admin/users', label: 'Users', icon: Users, requiresAdmin: true },
    { href: '/dashboard/admin/vendor-mappings', label: 'Vendor mappings', icon: BookOpen, requiresAdmin: true },
    { href: '/dashboard/admin/uom-conversions', label: 'UoM conversions', icon: ArrowLeftRight, requiresAdmin: true },
    { href: '/dashboard/admin/reconciliation', label: 'Reconciliation', icon: BarChart3, requiresAdmin: true },
    { href: '/dashboard/admin/audit', label: 'Audit log', icon: FileLock, requiresAdmin: true },
  ],
};

/**
 * Returns the nav structure visible to the given role. Each NavItem
 * is filtered by its `requires` permission (and `requiresAdmin` for
 * the Admin section). Sections that end up empty after filtering are
 * dropped so we don't render bare section headers.
 */
export function navForRole(role: Role): NavSection[] {
  const isAdmin = isAdminRole(role);
  const allSections = isAdmin ? [...BASE_NAV, ADMIN_NAV] : BASE_NAV;
  return allSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.requiresAdmin && !isAdmin) return false;
        if (item.requires && !hasPermission(role, item.requires)) return false;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

export const NAV: NavSection[] = BASE_NAV;
export const DASHBOARD_NAV_HREFS = [
  ...BASE_NAV.flatMap((s) => s.items.map((i) => i.href)),
  ...ADMIN_NAV.items.map((i) => i.href),
];
