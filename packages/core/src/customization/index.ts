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

import type { ModuleId, NavSectionKey } from '../modules/registry';
import type { ResolvedNavItem, ResolvedNavSection } from '../modules/resolve';
import { SECTION_ORDER } from '../modules/resolve';

// Per-org custom field definitions for items (registry types + pure validator).
export * from './custom-fields';

// Per-org order status presentation overrides (label/color/sortOrder resolver).
export * from './order-status';

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
 *  - order:   section -> ordered list of hrefs that should come first. Lists
 *             saved before the 2026-10-19 regroup still sit under the old
 *             keys and are read as they are (see orderNavSectionItems).
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
// Section order: one rule for the sidebar and the Navigation editor
// ---------------------------------------------------------------------------

/**
 * The sections the owner's regroup of 2026-10-19 created, each with the old
 * sections its links came from, in the order the old sidebar drew those.
 * Orgs that saved an order before the regroup keep it under the old keys
 * (order.inventory, order.workspace): nothing rewrites nav_overrides in the
 * database, so a rollback still reads every save. orderNavSectionItems reads
 * the old lists for a new section until an admin saves the editor again,
 * which writes the new keys.
 */
export const NAV_SECTIONS_SPLIT_FROM: Readonly<
  Partial<Record<NavSectionKey, readonly NavSectionKey[]>>
> = {
  fulfillment: ['inventory'],
  purchasing: ['inventory'],
  insights: ['inventory', 'workspace'],
};

/**
 * The section each module the regroup moved sat in before it. Every placement
 * of these modules, web and phone, moved together, so the module decides.
 */
export const NAV_FORMER_SECTION: Readonly<Partial<Record<ModuleId, NavSectionKey>>> = {
  rentals: 'inventory',
  bundles: 'inventory',
  orders: 'inventory',
  returns: 'inventory',
  purchase_orders: 'inventory',
  receiving: 'inventory',
  po_imports: 'inventory',
  suppliers: 'inventory',
  planning: 'inventory',
  reports: 'inventory',
  ai: 'workspace',
};

// Map lookups, so a module id or key can never match an Object prototype name.
const SPLIT_FROM = new Map(Object.entries(NAV_SECTIONS_SPLIT_FROM)) as ReadonlyMap<
  string,
  readonly NavSectionKey[]
>;
const FORMER_SECTION = new Map(Object.entries(NAV_FORMER_SECTION)) as ReadonlyMap<
  string,
  NavSectionKey
>;

/** The saved order list for `section`, or null when there is none to apply. */
function savedOrder(order: unknown, section: NavSectionKey): readonly unknown[] | null {
  if (!order || typeof order !== 'object') return null;
  const list = (order as Partial<Record<NavSectionKey, unknown>>)[section];
  return Array.isArray(list) && list.length > 0 ? list : null;
}

/**
 * Where an item lands when `list` orders its section: at its first place in
 * the list, or, when the list does not name it, after every place the list
 * holds, in default order.
 */
function placeIn(list: readonly unknown[] | null, href: string, defaultIndex: number): number {
  const at = list ? list.indexOf(href) : -1;
  return at >= 0 ? at : (list?.length ?? 0) + defaultIndex;
}

function sortedBy<T>(items: readonly T[], key: (item: T, index: number) => [number, number]): T[] {
  return items
    .map((item, index) => ({ item, key: key(item, index) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map(({ item }) => item);
}

/**
 * Order one section's items by the org's saved order: step (c) of
 * applyNavOverrides, exported so Settings > Navigation opens on exactly the
 * order the sidebar draws (and saves it, not the default, when nothing moved).
 *
 * `items` come in their default (resolved) order. When the org saved a list
 * for this section, the hrefs it names come first, in its order, and the rest
 * keep their default order; hrefs it names that are not in the section (a
 * link the regroup moved, a module turned off) are skipped.
 *
 * A section the regroup created has no list of its own until an admin saves
 * the editor again, so it reads the lists of the sections it came from and
 * draws its items in the order the old sidebar drew them: by old section
 * (Inventory above Workspace), then by place in that section's list, the
 * items a list does not name after the ones it names, in default order. So
 * order.inventory = [Orders, Items] puts Orders first in Fulfillment and
 * Items first in Inventory. The section's own list, once saved, always wins.
 *
 * Every item's place depends only on its own href and default index, never on
 * which other items are present, so hiding items (the sidebar drops them, the
 * editor keeps them) and a role seeing fewer links never reorder the rest.
 */
export function orderNavSectionItems<T extends { href: string; moduleId: string }>(
  section: NavSectionKey,
  items: readonly T[],
  order: NavOverrides['order'] | null | undefined,
): T[] {
  const own = savedOrder(order, section);
  if (own) return sortedBy(items, (it, index) => [0, placeIn(own, it.href, index)]);

  const from = SPLIT_FROM.get(section) ?? [];
  if (!from.some((key) => savedOrder(order, key))) return [...items];
  return sortedBy(items, (it, index) => {
    // The old section the item sat in. A link none of them held (a module
    // put in this section after the regroup) counts as one the first old
    // section's list does not name, like a module turned on after a save.
    const former = FORMER_SECTION.get(it.moduleId);
    const rank = former && from.includes(former) ? from.indexOf(former) : 0;
    return [rank, placeIn(savedOrder(order, from[rank] ?? section), it.href, index)];
  });
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
 *       (in that order); remaining items keep their resolved order. A section
 *       the 2026-10-19 regroup created, with no list of its own, follows the
 *       lists of the sections it came from (orderNavSectionItems)
 *   (d) append `custom` links to their section (validated; unsafe/badly-typed
 *       dropped) — these are the ONLY new items ever added. A link keeps the
 *       section it was saved under.
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
        sortOrder: typeof link.sortOrder === 'number' ? link.sortOrder : Number.MAX_SAFE_INTEGER,
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
    // the rest keeping their resolved order; a regrouped section with no list
    // of its own follows its old sections' lists. Unknown hrefs in a list are
    // ignored (no matching item).
    items = orderNavSectionItems(sec.section, items, order);

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
    result.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
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
    DASHBOARD_WIDGETS.filter((def) => availableSet.has(def.id) && !def.defaultHidden).map(
      (def) => def.id,
    );

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
