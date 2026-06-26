import { hasPermission, type Permission } from '../constants/permissions';
import { isAdminRole } from '../constants/terminology';
import type { Role } from '../constants/roles';
import {
  MODULE_REGISTRY,
  type ModuleId,
  type NavSurface,
  type NavSectionKey,
} from './registry';

/**
 * Pure navigation resolver shared by web + mobile.
 *
 * Turns (role + the org's enabled modules) into a filtered, section-grouped,
 * sort-ordered nav for one surface. No React / platform imports so this can
 * live in @stockpilot/core and run identically on both clients.
 *
 * Filtering rules, in order:
 *   1. The module must be on — `core` modules are always on; everything else
 *      must appear in `enabledModules`.
 *   2. `requiresAdmin` placements only show for admin/owner roles.
 *   3. `requires` placements only show when the caller has that permission —
 *      checked against the EFFECTIVE permission set when provided (so org-level
 *      role/user overrides hide or reveal nav links), else the static role map.
 * Empty sections are dropped; items within a section sort by
 * `defaultSortOrder` ascending; sections emit in a fixed canonical order.
 */

export interface ResolveInput {
  role: Role;
  enabledModules: Set<ModuleId>;
  /**
   * The caller's effective permissions (static role defaults with org
   * overrides applied). When supplied, `requires` placements gate on this set
   * so revoking e.g. purchase_orders:read hides the Purchase Orders link.
   * Optional for back-compat: callers that omit it fall back to the static
   * role permission map.
   */
  permissions?: ReadonlySet<Permission>;
}

export interface ResolvedNavItem {
  moduleId: ModuleId;
  label: string;
  href: string;
  iconName: string;
  section: NavSectionKey;
  sortOrder: number;
  requiresAdmin: boolean;
  badge?: string;
}

export interface ResolvedNavSection {
  section: NavSectionKey;
  items: ResolvedNavItem[];
}

/** Canonical section render order. Exported so a guard test can assert it
 *  covers every section any placement uses (a new section omitted here would
 *  silently never render). */
export const SECTION_ORDER: NavSectionKey[] = ['overview', 'inventory', 'workspace', 'tools', 'admin'];

export function resolveSurface(surface: NavSurface, input: ResolveInput): ResolvedNavSection[] {
  const admin = isAdminRole(input.role);
  const items: ResolvedNavItem[] = [];

  for (const def of Object.values(MODULE_REGISTRY)) {
    const moduleOn = def.tier === 'core' || input.enabledModules.has(def.id);
    if (!moduleOn) continue;

    for (const p of def.placements) {
      if (p.surface !== surface) continue;
      if (p.requiresAdmin && !admin) continue;
      if (
        p.requires &&
        !(input.permissions
          ? input.permissions.has(p.requires)
          : hasPermission(input.role, p.requires))
      )
        continue;
      items.push({
        moduleId: def.id,
        label: p.label,
        href: p.href,
        iconName: p.iconName,
        section: p.section,
        sortOrder: p.defaultSortOrder,
        requiresAdmin: !!p.requiresAdmin,
        badge: p.badge,
      });
    }
  }

  const bySection = new Map<NavSectionKey, ResolvedNavItem[]>();
  for (const it of items) {
    const arr = bySection.get(it.section) ?? [];
    arr.push(it);
    bySection.set(it.section, arr);
  }

  return SECTION_ORDER.filter((s) => (bySection.get(s)?.length ?? 0) > 0).map((s) => ({
    section: s,
    // Stable, deterministic order: sortOrder first, then label as a tiebreak
    // so two placements sharing a sortOrder never depend on engine sort order.
    items: bySection
      .get(s)!
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
  }));
}
