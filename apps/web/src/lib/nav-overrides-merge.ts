import {
  MODULE_REGISTRY,
  SECTION_ORDER,
  type NavOverrides,
  type NavSectionKey,
} from '@stockpilot/core';

/**
 * Merge a Save from Settings > Navigation into the organization's stored menu
 * setting.
 *
 * The editor lists the links of the modules that are on and sends a whole
 * setting for them. A link it did not list (its module is off, or was turned
 * on after the page opened) still has the admin's stored hide, rename and
 * place in a section's order, which the sidebar draws again once the module
 * is on (applyNavOverrides ignores entries for links it does not draw). So:
 *
 *   - `decided` is the set of links the save answers for: the links the
 *     editor listed. For those, the save's entries are the answer, so a hide
 *     undone, a rename cleared or a link moved is saved.
 *   - For every other link the product still has, the stored entries are
 *     kept: hidden and labels as they are, and in each order list at the
 *     place they held among their stored neighbours.
 *   - A stored entry for a link no module places in the web sidebar any more
 *     (removed from the product) can never be drawn, and is let go.
 *
 * Custom links are always listed by the editor, so they come from the save.
 * Returns null when nothing is left to store (the default menu).
 */
export function mergeNavOverrides(
  next: NavOverrides,
  stored: unknown,
  decided: ReadonlySet<string>,
  defaultOrder: ReadonlyMap<NavSectionKey, readonly string[]>,
): NavOverrides | null {
  const known = webSidebarHrefs();
  const keep = (href: unknown): href is string =>
    typeof href === 'string' && known.has(href) && !decided.has(href);
  const prior = readStored(stored);

  const hidden = unique([...(next.hidden ?? []), ...prior.hidden.filter(keep)]);

  const labels: Record<string, string> = {};
  for (const [href, label] of Object.entries(prior.labels)) {
    if (keep(href) && typeof label === 'string' && label.length > 0) labels[href] = label;
  }
  Object.assign(labels, next.labels ?? {});

  const order: Partial<Record<NavSectionKey, string[]>> = {};
  for (const section of SECTION_ORDER) {
    const own = next.order?.[section];
    const storedList = prior.order[section] ?? [];
    const kept = unique(storedList.filter(keep)).filter((h) => !own?.includes(h));
    if (kept.length === 0) {
      if (own) order[section] = [...own];
      continue;
    }
    // A section the save leaves in its default order is written out in that
    // order, so the kept links have neighbours to keep their place among.
    const base = own ?? (defaultOrder.get(section) ?? []).filter((h) => decided.has(h));
    order[section] = placeAmong(base, kept, storedList);
  }

  const custom = next.custom ?? [];
  const result: NavOverrides = {
    v: 1,
    ...(hidden.length > 0 ? { hidden } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(Object.keys(order).length > 0 ? { order } : {}),
    ...(custom.length > 0 ? { custom } : {}),
  };
  return Object.keys(result).length > 1 ? result : null;
}

/** Every href a module places in the web sidebar, for any role. */
function webSidebarHrefs(): Set<string> {
  const hrefs = new Set<string>();
  for (const def of Object.values(MODULE_REGISTRY)) {
    for (const p of def.placements) if (p.surface === 'web_sidebar') hrefs.add(p.href);
  }
  return hrefs;
}

interface StoredParts {
  hidden: unknown[];
  labels: Record<string, unknown>;
  order: Partial<Record<NavSectionKey, unknown[]>>;
}

/** The stored value's parts, read as the sidebar reads them (v:1 only). */
function readStored(stored: unknown): StoredParts {
  const empty: StoredParts = { hidden: [], labels: {}, order: {} };
  if (!stored || typeof stored !== 'object' || (stored as { v?: unknown }).v !== 1) return empty;
  const rec = stored as Record<string, unknown>;
  const order: Partial<Record<NavSectionKey, unknown[]>> = {};
  if (rec.order && typeof rec.order === 'object') {
    for (const section of SECTION_ORDER) {
      const list = (rec.order as Record<string, unknown>)[section];
      if (Array.isArray(list)) order[section] = list;
    }
  }
  return {
    hidden: Array.isArray(rec.hidden) ? rec.hidden : [],
    labels:
      rec.labels && typeof rec.labels === 'object' && !Array.isArray(rec.labels)
        ? (rec.labels as Record<string, unknown>)
        : {},
    order,
  };
}

/**
 * Put each kept href back after the nearest href before it in the stored list
 * that is already in place (or first, when none is), so it keeps its place
 * among its neighbours.
 */
function placeAmong(base: readonly string[], kept: readonly string[], storedList: unknown[]) {
  const out = [...base];
  for (const href of kept) {
    const at = storedList.indexOf(href);
    let pos = 0;
    for (let i = at - 1; i >= 0; i--) {
      const j = out.indexOf(storedList[i] as string);
      if (j >= 0) {
        pos = j + 1;
        break;
      }
    }
    out.splice(pos, 0, href);
  }
  return out;
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}
