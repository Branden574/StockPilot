import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  ClipboardList,
  Cog,
  Home,
  type LucideIcon,
  MapPin,
  Tag,
  Truck,
  Users,
} from 'lucide-react';

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

export const NAV: NavSection[] = [
  {
    items: [{ href: '/dashboard', label: 'Overview', icon: Home }],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Items', icon: Boxes },
      { href: '/dashboard/categories', label: 'Categories', icon: Tag },
      { href: '/dashboard/movements', label: 'Movements', icon: ArrowLeftRight },
      { href: '/dashboard/purchase-orders', label: 'Purchase orders', icon: ClipboardList },
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

export const DASHBOARD_NAV_HREFS = NAV.flatMap((section) => section.items.map((item) => item.href));
