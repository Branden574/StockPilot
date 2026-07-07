import {
  ArrowLeftRight,
  BarChart3,
  Book,
  BookOpen,
  Box,
  ClipboardCheck,
  ClipboardList,
  Layers,
  MapPin,
  PackageOpen,
  ScanLine,
  ShoppingCart,
  Tag,
  Tags,
  Truck,
  Upload,
  type LucideIcon,
} from 'lucide-react-native';

import type { TabSlotId } from './tab-config';

/**
 * Icons for the bottom tab bar + the customize screen, keyed by slot id.
 * Kept out of tab-config.ts so the pure config module stays free of
 * react-native imports (vitest runs it in node).
 *
 * The five legacy entries are the EXACT icons the old static layout used
 * (Layers/Book/Truck/ScanLine — note Items is Layers here, not the drawer's
 * Box), so the default bar renders pixel-identical. New candidates reuse
 * their drawer icons (nav-icons.ts / MODULE_REGISTRY names).
 */
export const HOME_TAB_ICON: LucideIcon = Box;

export const TAB_ICONS: Record<TabSlotId, LucideIcon> = {
  inventory: Layers,
  books: Book,
  receive: Truck,
  scan: ScanLine,
  'cycle-counts': ClipboardCheck,
  'orders-tab': ShoppingCart,
  'movements-tab': ArrowLeftRight,
  'reports-tab': BarChart3,
  // Drawer-parity candidates: same icons the drawer renders for these
  // destinations (mobile_drawer placements in MODULE_REGISTRY → NAV_ICONS).
  'categories-tab': Tag,
  'tags-tab': Tags,
  'rentals-tab': PackageOpen,
  'purchase-orders-tab': ClipboardList,
  'po-imports-tab': Upload,
  'locations-tab': MapPin,
  'suppliers-tab': Truck,
  'procedures-tab': BookOpen,
};
