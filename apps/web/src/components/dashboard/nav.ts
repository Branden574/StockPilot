import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Bell,
  Boxes,
  Building2,
  ClipboardList,
  Cog,
  FileLock,
  Home,
  type LucideIcon,
  MapPin,
  Network,
  Tag,
  Truck,
  Upload,
  Users,
  Warehouse,
} from 'lucide-react';

import type { Role } from '@stockpilot/core';
import { isAdminRole } from '@stockpilot/core';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string | number;
  alert?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

const BASE_NAV: NavSection[] = [
  {
    items: [{ href: '/dashboard', label: 'Overview', icon: Home }],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Items', icon: Boxes },
      { href: '/dashboard/books', label: 'Books', icon: BookOpen },
      { href: '/dashboard/categories', label: 'Categories', icon: Tag },
      { href: '/dashboard/movements', label: 'Movements', icon: ArrowLeftRight },
      { href: '/dashboard/purchase-orders', label: 'Purchase orders', icon: ClipboardList },
      { href: '/dashboard/purchase-orders/imports', label: 'PO imports', icon: Upload },
      { href: '/dashboard/locations', label: 'Locations', icon: MapPin },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
      { href: '/dashboard/team', label: 'Team', icon: Users },
      { href: '/dashboard/settings', label: 'Settings', icon: Cog },
    ],
  },
];

const ADMIN_NAV: NavSection = {
  label: 'Admin',
  items: [
    { href: '/dashboard/admin', label: 'Admin overview', icon: Network },
    { href: '/dashboard/admin/charters', label: 'Charters', icon: Building2 },
    { href: '/dashboard/admin/warehouses', label: 'Warehouses', icon: Warehouse },
    { href: '/dashboard/admin/bins', label: 'Bins', icon: MapPin },
    { href: '/dashboard/admin/users', label: 'Users', icon: Users },
    { href: '/dashboard/admin/vendor-mappings', label: 'Vendor mappings', icon: BookOpen },
    { href: '/dashboard/admin/uom-conversions', label: 'UoM conversions', icon: ArrowLeftRight },
    { href: '/dashboard/admin/reconciliation', label: 'Reconciliation', icon: BarChart3 },
    { href: '/dashboard/admin/audit', label: 'Audit log', icon: FileLock },
  ],
};

/**
 * Returns the nav structure visible to the given role. Super Admins
 * (owner/admin) see the Admin section; everyone else does not.
 */
export function navForRole(role: Role): NavSection[] {
  if (isAdminRole(role)) return [...BASE_NAV, ADMIN_NAV];
  return BASE_NAV;
}

export const NAV: NavSection[] = BASE_NAV;
export const DASHBOARD_NAV_HREFS = [
  ...BASE_NAV.flatMap((s) => s.items.map((i) => i.href)),
  ...ADMIN_NAV.items.map((i) => i.href),
];
