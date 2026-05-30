import {
  MODULE_REGISTRY,
  type ModuleId,
  resolveSurface,
  type Role,
} from '@stockpilot/core';
import type { LucideIcon } from 'lucide-react-native';

import { NAV_ICONS } from './nav-icons';

/**
 * Drawer nav, derived from the shared @stockpilot/core MODULE_REGISTRY rather
 * than a hand-maintained array. `resolveSurface('mobile_drawer', …)` returns
 * the role-filtered, module-gated, sort-ordered nav; we map its icon-name
 * strings to lucide components and its section keys to the UPPERCASE headers
 * the drawer has always used. The web sidebar already derives the same way
 * (Task 9), so the two surfaces stay 1:1 with the registry.
 *
 * The `mobile_drawer` placements were transcribed 1:1 from the old static
 * DRAWER_SECTIONS, so resolving for a given role with the full module set
 * reproduces today's drawer exactly (sections, items, labels, order, and the
 * "TAB" badge — see `inTabs`).
 */
export interface DrawerNavItem {
  id: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** True iff this item is also reachable as a bottom tab (renders a "TAB" badge). */
  inTabs?: boolean;
}

export interface DrawerNavSection {
  label?: string;
  items: DrawerNavItem[];
}

// Mobile uses UPPERCASE section headers (matches today's drawer). The overview
// section renders with no header.
const SECTION_LABEL: Record<string, string | undefined> = {
  overview: undefined,
  inventory: 'INVENTORY',
  workspace: 'WORKSPACE',
  tools: 'TOOLS',
  admin: 'ADMIN',
};

/**
 * Set of `mobile_drawer` hrefs whose placement is `mobileTabEligible`. Drives
 * the "TAB" badge in the drawer. resolveSurface doesn't carry the flag through
 * (it's not navigation-relevant), so we read it straight off the registry.
 * Today that's: '/', '/inventory', '/books', '/receive', '/scan'.
 */
const TAB_ELIGIBLE_HREFS: Set<string> = new Set(
  Object.values(MODULE_REGISTRY).flatMap((def) =>
    def.placements
      .filter((p) => p.surface === 'mobile_drawer' && p.mobileTabEligible)
      .map((p) => p.href),
  ),
);

export function drawerSectionsFor(
  role: Role,
  enabledModules: Set<ModuleId>,
): DrawerNavSection[] {
  return resolveSurface('mobile_drawer', { role, enabledModules }).map((sec) => ({
    label: SECTION_LABEL[sec.section],
    items: sec.items.map((it) => ({
      id: `${it.moduleId}:${it.href}`,
      href: it.href,
      label: it.label,
      icon: NAV_ICONS[it.iconName] ?? NAV_ICONS.Box,
      inTabs: TAB_ELIGIBLE_HREFS.has(it.href),
    })),
  }));
}
