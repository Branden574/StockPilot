import {
  ArrowLeftRight,
  BarChart3,
  Book,
  Box,
  ClipboardCheck,
  Layers,
  ScanLine,
  ShoppingCart,
  Truck,
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
};
