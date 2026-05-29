import { Boxes, type LucideIcon } from 'lucide-react';

import {
  DEFAULT_MODULE_IDS,
  resolveSurface,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { NAV_ICONS } from './icons';

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

/**
 * Maps the registry's section keys to the human-readable section headers
 * the sidebar renders. The `overview` section has no header (it's the
 * bare top group), matching the original static nav.
 */
const SECTION_LABEL: Record<string, string | undefined> = {
  overview: undefined,
  inventory: 'Inventory',
  workspace: 'Workspace',
  tools: 'Tools',
  admin: 'Admin',
};

/**
 * Derives the dashboard sidebar nav for a role + the org's enabled module
 * set, sourced entirely from the shared module registry via
 * `resolveSurface('web_sidebar', …)`. `resolveSurface` already filters by
 * module-on / `requiresAdmin` / `requires`, groups by section, drops empty
 * sections, and sort-orders items, so this is a thin shape adapter that
 * resolves icon-name strings to lucide components.
 */
export function navForRole(role: Role, enabledModules: Set<ModuleId>): NavSection[] {
  return resolveSurface('web_sidebar', { role, enabledModules }).map((sec) => ({
    label: SECTION_LABEL[sec.section],
    items: sec.items.map((it) => ({
      href: it.href,
      label: it.label,
      icon: NAV_ICONS[it.iconName] ?? Boxes,
      ...(it.badge ? { badge: it.badge } : {}),
    })),
  }));
}

/**
 * Full-superset href list (admin role, all default modules enabled) used by
 * the sidebar for route prefetch warming. Computed once at module load.
 */
export const DASHBOARD_NAV_HREFS = navForRole('admin', new Set(DEFAULT_MODULE_IDS)).flatMap((s) =>
  s.items.map((i) => i.href),
);
