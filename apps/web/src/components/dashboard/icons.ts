import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
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
  ShoppingCart,
  Sparkles,
  Tag,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  Upload,
  Users,
  Warehouse,
} from 'lucide-react';

/**
 * Maps every `iconName` string used by the registry's `web_sidebar`
 * placements to its concrete lucide-react component. The registry stores
 * icon names as strings (so it stays platform-agnostic and importable from
 * `@stockpilot/core`); the web sidebar resolves them to components here.
 *
 * Keep this in sync with the distinct `iconName`s across `web_sidebar`
 * placements in `packages/core/src/modules/registry.ts`.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  Cog,
  FileLock,
  Home,
  MapPin,
  Network,
  Package,
  PackageOpen,
  ShoppingCart,
  Sparkles,
  Tag,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  Upload,
  Users,
  Warehouse,
};
