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
  Handshake,
  Home,
  Layers,
  type LucideIcon,
  MapPin,
  Network,
  Package,
  PackageOpen,
  RefreshCw,
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

import { ZendeskLogo } from '@/components/zendesk-logo';

/**
 * Maps the lucide `iconName` strings carried by `mobile_drawer` placements in
 * the @stockpilot/core MODULE_REGISTRY to their concrete lucide-react-native
 * components. The registry stores icons as strings (it's platform-free); each
 * client resolves them to its own icon set. Keep this in sync with the icon
 * names used by `surface: 'mobile_drawer'` placements — every name there must
 * have an entry, or it falls back to `Box`.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  Home,
  Handshake,
  RefreshCw,
  Box,
  BookOpen,
  Tag,
  Tags,
  ArrowLeftRight,
  PackageOpen,
  Package,
  ShoppingCart,
  ClipboardCheck,
  Truck,
  ClipboardList,
  Upload,
  MapPin,
  BarChart3,
  Sparkles,
  Calendar,
  Bell,
  Users,
  Cog,
  ScanLine,
  Network,
  Building2,
  Warehouse,
  Layers,
  FileLock,
  // Zendesk uses a custom react-native-svg mark (not in lucide); cast to
  // LucideIcon since it accepts the same { size, color } prop shape the
  // drawer renders with.
  Zendesk: ZendeskLogo as unknown as LucideIcon,
};
