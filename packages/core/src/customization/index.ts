/**
 * Per-org customization for the dashboard sidebar nav + landing widget layout.
 *
 * These are PURE functions — no React, no platform imports — so they live in
 * @stockpilot/core and run identically on web + mobile + the server action that
 * persists the config onto the organizations row (jsonb columns added in 0158).
 *
 * THE SECURITY BOUNDARY: the nav override layer runs AFTER resolveSurface (which
 * already filters by module-on / requiresAdmin / requires-permission). It may
 * ONLY hide, rename, or reorder items that resolveSurface already returned, plus
 * append explicitly-defined custom links (validated by isSafeNavHref). It is
 * STRUCTURALLY INCAPABLE of surfacing nav for a module the org has not enabled:
 * applyNavOverrides never constructs a non-custom item, it only operates on the
 * `sections` array it is handed. Anything malformed fails CLOSED to the derived
 * nav / default layout.
 */

import type { NavSectionKey } from '../modules/registry';
import type { ResolvedNavItem, ResolvedNavSection } from '../modules/resolve';
import { SECTION_ORDER } from '../modules/resolve';

// Per-org custom field definitions for items (registry types + pure validator).
export * from './custom-fields';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An admin-defined extra sidebar link. `href` is gated by isSafeNavHref. */
export interface CustomNavLink {
  id: string;
  label: string;
  href: string;
  section: NavSectionKey;
  iconName: string;
  sortOrder?: number;
}

/**
 * Per-org nav customization. Versioned (`v: 1`) so future shapes can migrate.
 *  - hidden:  hrefs to drop from the derived nav.
 *  - labels:  href -> replacement label.
 *  - order:   section -> ordered list of hrefs that should come first.
 *  - custom:  extra links to append (validated; unsafe/badly-typed dropped).
 */
export interface NavOverrides {
  v: 1;
  hidden?: string[];
  labels?: Record<string, string>;
  order?: Partial<Record<NavSectionKey, string[]>>;
  custom?: CustomNavLink[];
}

/** Per-org dashboard widget layout. `widgets` is the ordered, visible set. */
export interface DashboardLayout {
  v: 1;
  widgets: Array<{ id: string; hidden?: boolean }>;
}

/** Catalog metadata for a single dashboard widget. */
export interface DashboardWidgetDef {
  id: string;
  title: string;
  defaultHidden?: boolean;
}

// ---------------------------------------------------------------------------
// Widget catalog (canonical order). T3a binds components to these stable ids.
// ---------------------------------------------------------------------------

export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = [
  { id: 'get-started', title: 'Get started' },
  { id: 'needs-attention', title: 'Needs attention' },
  { id: 'trends-header', title: 'Trends' },
  { id: 'shift-command', title: 'Shift command' },
  { id: 'stat-row', title: 'Key stats' },
  { id: 'value-chart', title: 'Inventory value' },
  { id: 'movements-breakdown', title: 'Movements breakdown' },
  { id: 'analytics', title: 'Analytics' },
  { id: 'recent-activity', title: 'Recent activity' },
];

const SECTION_KEYS: ReadonlySet<string> = new Set<string>(SECTION_ORDER);

// ---------------------------------------------------------------------------
// Safety gate for custom link hrefs (the XSS boundary for custom links)
// ---------------------------------------------------------------------------

/** True if the string contains any C0 control char or DEL (0x00–0x1F, 0x7F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Allow ONLY:
 *   - an internal path: starts with a single '/' (not '//', not control chars), OR
 *   - an absolute http(s):// URL.
 * Reject everything else — javascript:, data:, vbscript:, mixed-case schemes,
 * protocol-relative '//host', and any href containing control characters
 * (e.g. "java\tscript:" that could otherwise mask a scheme).
 */
export function isSafeNavHref(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (value.length === 0) return false;
  if (hasControlChar(value)) return false;

  // Internal path: a single leading slash, never protocol-relative '//'.
  if (value.startsWith('/')) {
    return !value.startsWith('//');
  }

  // Absolute URL: only http(s). Anything else (javascript:, data:, vbscript:,
  // file:, etc.) is rejected. Scheme match is case-insensitive but exact.
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// applyNavOverrides — pure post-filter over resolveSurface output
// ---------------------------------------------------------------------------

function isValidOverrides(o: unknown): o is NavOverrides {
  if (!o || typeof o !== 'object') return false;
  const rec = o as Record<string, unknown>;
  return rec.v === 1;
}

/**
 * Apply a per-org NavOverrides on top of resolved sections. Order of ops:
 *   (a) drop items whose href is in `hidden`
 *   (b) rename via `labels` (href -> new label)
 *   (c) within each section reorder so hrefs in `order[section]` come first
 *       (in that order); remaining items keep their resolved order
 *   (d) append `custom` links to their section (validated; unsafe/badly-typed
 *       dropped) — these are the ONLY new items ever added.
 *
 * Unknown hrefs (in hidden/labels/order) are ignored, never error. A
 * null/garbage `overrides` returns `sections` unchanged (fail-closed).
 * Never constructs a non-custom item, so a disabled module stays gone.
 */
export function applyNavOverrides(
  sections: ResolvedNavSection[],
  overrides: NavOverrides | null,
): ResolvedNavSection[] {
  if (!isValidOverrides(overrides)) return sections;

  const hidden = new Set<string>(
    Array.isArray(overrides.hidden)
      ? overrides.hidden.filter((h): h is string => typeof h === 'string')
      : [],
  );
  const labels: Record<string, string> =
    overrides.labels && typeof overrides.labels === 'object' ? overrides.labels : {};
  const order: Partial<Record<NavSectionKey, string[]>> =
    overrides.order && typeof overrides.order === 'object' ? overrides.order : {};

  // (d) Pre-bucket valid custom links by section so we can append per-section.
  const customBySection = new Map<NavSectionKey, ResolvedNavItem[]>();
  if (Array.isArray(overrides.custom)) {
    for (const link of overrides.custom) {
      if (!link || typeof link !== 'object') continue;
      const { id, label, href, section, iconName } = link as CustomNavLink;
      if (typeof id !== 'string' || typeof label !== 'string') continue;
      if (typeof iconName !== 'string') continue;
      if (typeof section !== 'string' || !SECTION_KEYS.has(section)) continue;
      if (!isSafeNavHref(href)) continue;
      const item: ResolvedNavItem = {
        // Custom links are not registry-backed nav; carry a `custom:<id>`
        // sentinel so adapters can branch on it. The double cast is deliberate:
        // a custom link intentionally has no real ModuleId, and this value
        // never flows back into module resolution.
        moduleId: `custom:${id}` as unknown as ResolvedNavItem['moduleId'],
        label,
        href,
        iconName,
        section,
        sortOrder:
          typeof link.sortOrder === 'number' ? link.sortOrder : Number.MAX_SAFE_INTEGER,
        requiresAdmin: false,
      };
      const arr = customBySection.get(section) ?? [];
      arr.push(item);
      customBySection.set(section, arr);
    }
  }

  const result: ResolvedNavSection[] = [];

  for (const sec of sections) {
    // (a) drop hidden, (b) rename via labels.
    let items: ResolvedNavItem[] = sec.items
      .filter((it) => !hidden.has(it.href))
      .map((it) => {
        const newLabel = labels[it.href];
        return typeof newLabel === 'string' && newLabel.length > 0
          ? { ...it, label: newLabel }
          : it;
      });

    // (c) reorder: hrefs listed in order[section] first (in that order), then
    // the rest keeping their resolved order. Unknown hrefs in the list are
    // ignored (no matching item).
    const wanted = order[sec.section];
    if (Array.isArray(wanted) && wanted.length > 0) {
      const byHref = new Map<string, ResolvedNavItem>();
      for (const it of items) byHref.set(it.href, it);
      const seen = new Set<string>();
      const front: ResolvedNavItem[] = [];
      for (const href of wanted) {
        const it = byHref.get(href);
        if (it && !seen.has(href)) {
          front.push(it);
          seen.add(href);
        }
      }
      const rest = items.filter((it) => !seen.has(it.href));
      items = [...front, ...rest];
    }

    // (d) append validated custom links for this section.
    const customs = customBySection.get(sec.section);
    if (customs && customs.length > 0) {
      items = [...items, ...customs.slice().sort((a, b) => a.sortOrder - b.sortOrder)];
      customBySection.delete(sec.section);
    }

    result.push({ section: sec.section, items });
  }

  // Custom links whose section had NO resolved items yet: emit a new section so
  // the link is not silently dropped. (Still only custom items — never a module
  // item.) Re-sort into canonical SECTION_ORDER afterward.
  if (customBySection.size > 0) {
    for (const sec of SECTION_ORDER) {
      const customs = customBySection.get(sec);
      if (!customs || customs.length === 0) continue;
      if (result.some((r) => r.section === sec)) continue;
      result.push({
        section: sec,
        items: customs.slice().sort((a, b) => a.sortOrder - b.sortOrder),
      });
    }
    result.sort(
      (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveDashboardWidgets — ordered, visible widget-id list
// ---------------------------------------------------------------------------

function isValidLayout(l: unknown): l is DashboardLayout {
  if (!l || typeof l !== 'object') return false;
  const rec = l as Record<string, unknown>;
  if (rec.v !== 1) return false;
  return Array.isArray(rec.widgets);
}

/**
 * Resolve the ordered, visible widget-id list for the dashboard.
 *
 *  - null/garbage layout -> the catalog's default order, honoring each def's
 *    `defaultHidden` (all visible unless flagged).
 *  - honor `layout.widgets` order + per-widget `hidden` flags
 *  - DROP ids not present in `available` (the catalog of shippable widgets)
 *  - APPEND any available id missing from the layout at the end, visible (so a
 *    newly-shipped widget shows up for orgs that already saved a layout).
 *
 * Fail-closed: a malformed layout returns the default order.
 */
export function resolveDashboardWidgets(
  layout: DashboardLayout | null,
  available: string[],
): string[] {
  const availableSet = new Set<string>(available);

  const defaultOrder = (): string[] =>
    DASHBOARD_WIDGETS.filter(
      (def) => availableSet.has(def.id) && !def.defaultHidden,
    ).map((def) => def.id);

  if (!isValidLayout(layout)) return defaultOrder();

  const out: string[] = [];
  const placed = new Set<string>();

  for (const w of layout.widgets) {
    if (!w || typeof w !== 'object') continue;
    const id = (w as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    if (!availableSet.has(id)) continue; // drop unknown / no-longer-shipped
    if (placed.has(id)) continue; // dedupe
    placed.add(id);
    if ((w as { hidden?: unknown }).hidden === true) continue; // honor hidden
    out.push(id);
  }

  // Append available ids missing from the layout, visible, in catalog order.
  for (const def of DASHBOARD_WIDGETS) {
    if (!availableSet.has(def.id)) continue;
    if (placed.has(def.id)) continue;
    if (def.defaultHidden) continue;
    out.push(def.id);
  }

  return out;
}
