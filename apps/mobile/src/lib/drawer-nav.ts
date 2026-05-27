import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Box,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  Cog,
  FileLock,
  Home,
  Layers,
  type LucideIcon,
  MapPin,
  Network,
  Package,
  PackageOpen,
  ScanLine,
  ShoppingCart,
  Sparkles,
  Tag,
  Tags,
  Truck,
  Upload,
  Users,
  Warehouse,
} from 'lucide-react-native';

/**
 * Drawer nav mirroring the web sidebar at apps/web/src/components/dashboard/nav.ts.
 * Items flagged `inTabs: true` are also shown as bottom tabs. Items in the
 * ADMIN section render only when the current user's role is admin/owner —
 * the drawer-content filters by role at render time.
 */
export interface DrawerNavItem {
  id: string;
  href: string;
  label: string;
  icon: LucideIcon;
  inTabs?: boolean;
  /** True iff the entire section requires admin/owner role. */
  admin?: boolean;
}

export interface DrawerNavSection {
  label?: string;
  items: DrawerNavItem[];
  admin?: boolean;
}

export const DRAWER_SECTIONS: DrawerNavSection[] = [
  {
    items: [
      { id: 'home', href: '/', label: 'Overview', icon: Home, inTabs: true },
    ],
  },
  {
    label: 'INVENTORY',
    items: [
      { id: 'items', href: '/inventory', label: 'Items', icon: Box, inTabs: true },
      { id: 'books', href: '/books', label: 'Books', icon: BookOpen },
      { id: 'categories', href: '/categories', label: 'Categories', icon: Tag },
      { id: 'tags', href: '/tags', label: 'Tags', icon: Tags },
      { id: 'movements', href: '/movements', label: 'Movements', icon: ArrowLeftRight },
      { id: 'rentals', href: '/rentals', label: 'Rentals', icon: PackageOpen },
      { id: 'bundles', href: '/bundles', label: 'Bundles', icon: Package },
      { id: 'orders', href: '/orders', label: 'Orders', icon: ShoppingCart },
      { id: 'counts', href: '/cycle-counts', label: 'Cycle counts', icon: ClipboardCheck, inTabs: true },
      { id: 'procedures', href: '/procedures', label: 'Procedures', icon: BookOpen },
      { id: 'po', href: '/receive', label: 'Receive POs', icon: Truck, inTabs: true },
      { id: 'po-mgmt', href: '/purchase-orders', label: 'Purchase orders', icon: ClipboardList },
      { id: 'po-imports', href: '/po-imports', label: 'PO imports', icon: Upload },
      { id: 'locations', href: '/locations', label: 'Locations', icon: MapPin },
      { id: 'suppliers', href: '/suppliers', label: 'Suppliers', icon: Truck },
      { id: 'reports', href: '/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'WORKSPACE',
    items: [
      { id: 'ai', href: '/ai', label: 'AI Assistant', icon: Sparkles },
      { id: 'schedule', href: '/schedule', label: 'Schedule', icon: Calendar },
      { id: 'notifications', href: '/notifications', label: 'Notifications', icon: Bell },
      { id: 'team', href: '/team', label: 'Team', icon: Users },
      { id: 'settings', href: '/settings', label: 'Settings', icon: Cog },
    ],
  },
  {
    label: 'TOOLS',
    items: [
      { id: 'scan', href: '/scan', label: 'Scan', icon: ScanLine, inTabs: true },
    ],
  },
  {
    label: 'ADMIN',
    admin: true,
    items: [
      { id: 'admin-overview', href: '/admin', label: 'Admin overview', icon: Network, admin: true },
      { id: 'admin-charters', href: '/admin/charters', label: 'Charters', icon: Building2, admin: true },
      { id: 'admin-warehouses', href: '/admin/warehouses', label: 'Warehouses', icon: Warehouse, admin: true },
      { id: 'admin-bins', href: '/admin/bins', label: 'Bins', icon: MapPin, admin: true },
      { id: 'admin-users', href: '/admin/users', label: 'Users', icon: Users, admin: true },
      { id: 'admin-vendor-mappings', href: '/admin/vendor-mappings', label: 'Vendor mappings', icon: Layers, admin: true },
      { id: 'admin-uom', href: '/admin/uom-conversions', label: 'UoM conversions', icon: ArrowLeftRight, admin: true },
      { id: 'admin-reconciliation', href: '/admin/reconciliation', label: 'Reconciliation', icon: BarChart3, admin: true },
      { id: 'admin-audit', href: '/admin/audit', label: 'Audit log', icon: FileLock, admin: true },
    ],
  },
];
