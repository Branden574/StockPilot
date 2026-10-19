import { describe, expect, it } from 'vitest';
import type { Role } from '../constants/roles';
import { MODULE_REGISTRY, type ModuleId } from '../modules/registry';
import {
  resolveSurface,
  SECTION_ORDER,
  type ResolvedNavItem,
  type ResolvedNavSection,
} from '../modules/resolve';
import {
  applyNavOverrides,
  DASHBOARD_WIDGETS,
  isSafeNavHref,
  NAV_FORMER_SECTION,
  NAV_SECTIONS_SPLIT_FROM,
  orderNavSectionItems,
  resolveDashboardWidgets,
  type NavOverrides,
  type DashboardLayout,
} from './index';

// --- helpers ---------------------------------------------------------------

function item(
  href: string,
  label: string,
  partial: Partial<ResolvedNavItem> = {},
): ResolvedNavItem {
  return {
    moduleId: 'inventory',
    label,
    href,
    iconName: 'Box',
    section: 'inventory',
    sortOrder: 0,
    requiresAdmin: false,
    ...partial,
  };
}

function baseSections(): ResolvedNavSection[] {
  return [
    {
      section: 'overview',
      items: [item('/dashboard', 'Overview', { moduleId: 'overview', section: 'overview' })],
    },
    {
      section: 'inventory',
      items: [
        item('/dashboard/inventory', 'Inventory', { sortOrder: 0 }),
        item('/dashboard/books', 'Books', { moduleId: 'books', sortOrder: 1 }),
        item('/dashboard/movements', 'Movements', { moduleId: 'movements', sortOrder: 2 }),
      ],
    },
  ];
}

const hrefs = (secs: ResolvedNavSection[]) => secs.flatMap((s) => s.items.map((i) => i.href));

// --- isSafeNavHref ---------------------------------------------------------

describe('isSafeNavHref', () => {
  it('accepts internal paths', () => {
    expect(isSafeNavHref('/dashboard/x')).toBe(true);
    expect(isSafeNavHref('/')).toBe(true);
    expect(isSafeNavHref('/a/b/c?q=1#h')).toBe(true);
  });
  it('accepts absolute http(s) URLs', () => {
    expect(isSafeNavHref('https://x.com')).toBe(true);
    expect(isSafeNavHref('http://x.com/path')).toBe(true);
    expect(isSafeNavHref('HTTPS://x.com')).toBe(true);
  });
  it('rejects javascript: (incl. mixed case + leading space)', () => {
    expect(isSafeNavHref('javascript:alert(1)')).toBe(false);
    expect(isSafeNavHref('jaVaScRipt:alert(1)')).toBe(false);
    expect(isSafeNavHref('  javascript:alert(1)')).toBe(false);
  });
  it('rejects data:, vbscript:, file: and other schemes', () => {
    expect(isSafeNavHref('data:text/html;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeNavHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeNavHref('file:///etc/passwd')).toBe(false);
    expect(isSafeNavHref('ftp://x.com')).toBe(false);
  });
  it('rejects protocol-relative //host', () => {
    expect(isSafeNavHref('//evil.com')).toBe(false);
    expect(isSafeNavHref('//evil.com/path')).toBe(false);
  });
  it('rejects control-char obfuscation and non-strings', () => {
    expect(isSafeNavHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeNavHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeNavHref('jav\x00ascript:alert(1)')).toBe(false);
    expect(isSafeNavHref('')).toBe(false);
    expect(isSafeNavHref('   ')).toBe(false);
    expect(isSafeNavHref(null)).toBe(false);
    expect(isSafeNavHref(undefined)).toBe(false);
    expect(isSafeNavHref(42 as unknown)).toBe(false);
  });
});

// --- applyNavOverrides -----------------------------------------------------

describe('applyNavOverrides', () => {
  it('null / garbage overrides => passthrough unchanged', () => {
    const secs = baseSections();
    expect(applyNavOverrides(secs, null)).toEqual(secs);
    expect(applyNavOverrides(secs, {} as unknown as NavOverrides)).toEqual(secs);
    expect(applyNavOverrides(secs, { v: 2 } as unknown as NavOverrides)).toEqual(secs);
    expect(applyNavOverrides(secs, 'nope' as unknown as NavOverrides)).toEqual(secs);
  });

  it('hides items by href', () => {
    const out = applyNavOverrides(baseSections(), { v: 1, hidden: ['/dashboard/books'] });
    expect(hrefs(out)).not.toContain('/dashboard/books');
    expect(hrefs(out)).toContain('/dashboard/inventory');
  });

  it('renames items via labels', () => {
    const out = applyNavOverrides(baseSections(), {
      v: 1,
      labels: { '/dashboard/inventory': 'Stock' },
    });
    const inv = out
      .find((s) => s.section === 'inventory')!
      .items.find((i) => i.href === '/dashboard/inventory')!;
    expect(inv.label).toBe('Stock');
  });

  it('reorders within a section, remaining items keep resolved order', () => {
    const out = applyNavOverrides(baseSections(), {
      v: 1,
      order: { inventory: ['/dashboard/movements', '/dashboard/inventory'] },
    });
    const inv = out.find((s) => s.section === 'inventory')!.items.map((i) => i.href);
    expect(inv).toEqual([
      '/dashboard/movements',
      '/dashboard/inventory',
      '/dashboard/books', // not listed -> keeps resolved order, lands last
    ]);
  });

  it('appends valid custom links to their section', () => {
    const out = applyNavOverrides(baseSections(), {
      v: 1,
      custom: [
        {
          id: 'wiki',
          label: 'Team Wiki',
          href: 'https://wiki.example.com',
          section: 'tools',
          iconName: 'BookOpen',
        },
        {
          id: 'sop',
          label: 'SOPs',
          href: '/dashboard/inventory/sops',
          section: 'inventory',
          iconName: 'FileText',
        },
      ],
    });
    const inv = out.find((s) => s.section === 'inventory')!.items.map((i) => i.href);
    expect(inv[inv.length - 1]).toBe('/dashboard/inventory/sops'); // appended last
    const tools = out.find((s) => s.section === 'tools');
    expect(tools).toBeDefined(); // brand-new section emitted for the custom link
    expect(tools!.items.map((i) => i.href)).toEqual(['https://wiki.example.com']);
  });

  it('drops custom links failing the safe-href gate or with bad section', () => {
    const out = applyNavOverrides(baseSections(), {
      v: 1,
      custom: [
        { id: 'x', label: 'XSS', href: 'javascript:alert(1)', section: 'inventory', iconName: 'X' },
        { id: 'y', label: 'BadSection', href: '/ok', section: 'nope' as never, iconName: 'X' },
        { id: 'z', label: 'BadIcon', href: '/ok2', section: 'inventory', iconName: 42 as never },
      ],
    });
    expect(hrefs(out)).not.toContain('javascript:alert(1)');
    expect(hrefs(out)).not.toContain('/ok');
    expect(hrefs(out)).not.toContain('/ok2');
  });

  it('ignores unknown hrefs in hidden/labels/order (no error)', () => {
    const out = applyNavOverrides(baseSections(), {
      v: 1,
      hidden: ['/nope'],
      labels: { '/nope': 'X' },
      order: { inventory: ['/nope'] },
    });
    expect(hrefs(out)).toEqual(hrefs(baseSections()));
  });

  it('SECURITY: cannot surface nav for a module not already in sections', () => {
    // A custom link can NEVER be a real module placement: even if an attacker
    // names a custom link after a disabled module's href, it is appended as a
    // tagged custom item, and no NON-custom item is ever constructed.
    const secs = baseSections(); // contains NO '/dashboard/rentals'
    const out = applyNavOverrides(secs, {
      v: 1,
      hidden: [],
      // try to "reveal" rentals via order + labels — both no-ops since the item
      // isn't in `sections`.
      order: { inventory: ['/dashboard/rentals'] },
      labels: { '/dashboard/rentals': 'Rentals' },
    });
    expect(hrefs(out)).not.toContain('/dashboard/rentals');
    // Every emitted non-custom item must trace back to an item in `sections`.
    const originalHrefs = new Set(hrefs(secs));
    for (const sec of out) {
      for (const it of sec.items) {
        const isCustom = String(it.moduleId).startsWith('custom:');
        if (!isCustom) expect(originalHrefs.has(it.href)).toBe(true);
      }
    }
  });
});

// --- the 2026-10-19 regroup: saved orders carry over ------------------------
//
// OWNER DECISION 2026-10-19: Fulfillment, Purchasing and Insights split out of
// Inventory and Workspace. An org's saved order stays in the database under
// the old keys; these pin that the sidebar reads it at resolve time, so every
// link keeps its place relative to the links around it.

describe('applyNavOverrides after the 2026-10-19 regroup', () => {
  const EVERY_MODULE = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
  /** The real web sidebar, every module on. */
  const sidebar = (role: Role = 'admin') =>
    resolveSurface('web_sidebar', { role, enabledModules: EVERY_MODULE });
  const linksOf = (secs: ResolvedNavSection[], section: string) =>
    secs.find((s) => s.section === section)?.items.map((i) => i.href);

  // An order saved from the editor before the regroup: the whole Inventory
  // section as the admin arranged it (Orders and Purchase orders pulled up,
  // Locations ahead of Movements) and the whole Workspace section (Briefing
  // above AI Assistant).
  const OLD_INVENTORY = [
    '/dashboard/orders',
    '/dashboard/purchase-orders',
    '/dashboard/inventory',
    '/dashboard/inventory/staging',
    '/dashboard/exceptions',
    '/dashboard/books',
    '/dashboard/product-groups',
    '/dashboard/categories',
    '/dashboard/tags',
    '/dashboard/locations',
    '/dashboard/movements',
    '/dashboard/rentals',
    '/dashboard/bundles',
    '/dashboard/returns',
    '/dashboard/cycle-counts',
    '/dashboard/procedures',
    '/dashboard/purchase-orders/recurring',
    '/dashboard/planning',
    '/dashboard/purchase-orders/imports',
    '/dashboard/suppliers',
    '/dashboard/reports',
  ];
  const OLD_WORKSPACE = [
    '/dashboard/insights',
    '/dashboard/ai',
    '/dashboard/schedule',
    '/dashboard/notifications',
    '/dashboard/team',
    '/dashboard/support',
    '/dashboard/settings',
    '/dashboard/customers',
    '/dashboard/maintenance',
    '/dashboard/zendesk',
  ];

  it("the owner's example: order.inventory = [Orders, Items] puts Orders first in Fulfillment and Items first in Inventory", () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: { inventory: ['/dashboard/orders', '/dashboard/inventory'] },
    });
    expect(linksOf(out, 'fulfillment')).toEqual([
      '/dashboard/orders',
      // Not in the list: after it, in default order, as they were.
      '/dashboard/rentals',
      '/dashboard/bundles',
      '/dashboard/returns',
    ]);
    expect(linksOf(out, 'inventory')?.[0]).toBe('/dashboard/inventory');
    // Orders is in Fulfillment only: the moved link is skipped in Inventory.
    expect(linksOf(out, 'inventory')).not.toContain('/dashboard/orders');
    expect(linksOf(out, 'inventory')).toEqual(linksOf(sidebar(), 'inventory'));
  });

  it('a whole saved section carries over: every link keeps its place relative to the others', () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: { inventory: OLD_INVENTORY, workspace: OLD_WORKSPACE },
    });
    expect(linksOf(out, 'inventory')).toEqual([
      '/dashboard/inventory',
      '/dashboard/inventory/staging',
      '/dashboard/exceptions',
      '/dashboard/books',
      '/dashboard/product-groups',
      '/dashboard/categories',
      '/dashboard/tags',
      '/dashboard/locations',
      '/dashboard/movements',
      '/dashboard/cycle-counts',
      '/dashboard/procedures',
    ]);
    expect(linksOf(out, 'fulfillment')).toEqual([
      '/dashboard/orders',
      '/dashboard/rentals',
      '/dashboard/bundles',
      '/dashboard/returns',
    ]);
    expect(linksOf(out, 'purchasing')).toEqual([
      '/dashboard/purchase-orders',
      '/dashboard/purchase-orders/recurring',
      '/dashboard/planning',
      '/dashboard/purchase-orders/imports',
      '/dashboard/suppliers',
    ]);
    // Reports came from Inventory, which was drawn above Workspace, so it stays
    // above the two links that came from Workspace, which keep their own order.
    expect(linksOf(out, 'insights')).toEqual([
      '/dashboard/reports',
      '/dashboard/insights',
      '/dashboard/ai',
    ]);
    expect(linksOf(out, 'workspace')).toEqual([
      '/dashboard/schedule',
      '/dashboard/notifications',
      '/dashboard/team',
      '/dashboard/support',
      '/dashboard/settings',
      '/dashboard/customers',
      '/dashboard/maintenance',
      '/dashboard/zendesk',
    ]);
  });

  it('Insights from a saved Workspace list alone: Reports still leads, then the saved order', () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: { workspace: ['/dashboard/insights', '/dashboard/schedule'] },
    });
    expect(linksOf(out, 'insights')).toEqual([
      '/dashboard/reports',
      '/dashboard/insights',
      '/dashboard/ai',
    ]);
    expect(linksOf(out, 'workspace')?.[0]).toBe('/dashboard/schedule');
  });

  it('Insights from a saved Inventory list alone: Reports, then AI Assistant and Briefing in default order', () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: { inventory: ['/dashboard/reports', '/dashboard/inventory'] },
    });
    expect(linksOf(out, 'insights')).toEqual([
      '/dashboard/reports',
      '/dashboard/ai',
      '/dashboard/insights',
    ]);
  });

  it("a section's own saved list beats the list it came from", () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: {
        inventory: OLD_INVENTORY,
        fulfillment: ['/dashboard/bundles', '/dashboard/returns'],
        insights: ['/dashboard/ai'],
      },
    });
    expect(linksOf(out, 'fulfillment')).toEqual([
      '/dashboard/bundles',
      '/dashboard/returns',
      '/dashboard/rentals',
      '/dashboard/orders',
    ]);
    expect(linksOf(out, 'insights')).toEqual([
      '/dashboard/ai',
      '/dashboard/reports',
      '/dashboard/insights',
    ]);
    // Purchasing has no list of its own, so it still carries the old one over.
    expect(linksOf(out, 'purchasing')?.[0]).toBe('/dashboard/purchase-orders');
    expect(linksOf(out, 'purchasing')?.[2]).toBe('/dashboard/planning');
  });

  it('with no saved list, or an empty or garbage one, every section keeps its default order', () => {
    const base = sidebar();
    for (const order of [
      undefined,
      {},
      { inventory: [] },
      { inventory: 'nope' },
      { workspace: null },
      { admin: ['/dashboard/audit'] },
    ]) {
      const out = applyNavOverrides(base, { v: 1, order } as unknown as NavOverrides);
      for (const section of ['inventory', 'fulfillment', 'purchasing', 'insights', 'workspace']) {
        expect(linksOf(out, section), `${JSON.stringify(order)} ${section}`).toEqual(
          linksOf(base, section),
        );
      }
    }
  });

  it('hidden and renamed moved links still apply, by href, in their new sections', () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      hidden: ['/dashboard/orders', '/dashboard/ai'],
      labels: { '/dashboard/purchase-orders': 'Buying', '/dashboard/reports': 'Analytics' },
      order: { inventory: OLD_INVENTORY, workspace: OLD_WORKSPACE },
    });
    expect(linksOf(out, 'fulfillment')).toEqual([
      '/dashboard/rentals',
      '/dashboard/bundles',
      '/dashboard/returns',
    ]);
    expect(linksOf(out, 'insights')).toEqual(['/dashboard/reports', '/dashboard/insights']);
    const label = (href: string) => out.flatMap((s) => s.items).find((i) => i.href === href)?.label;
    expect(label('/dashboard/purchase-orders')).toBe('Buying');
    expect(label('/dashboard/reports')).toBe('Analytics');
    expect(out.find((s) => s.section === 'purchasing')?.items[0]?.label).toBe('Buying');
  });

  it('a role that sees fewer links keeps the same relative order', () => {
    const order = { inventory: OLD_INVENTORY, workspace: OLD_WORKSPACE };
    const admin = applyNavOverrides(sidebar('admin'), { v: 1, order });
    for (const role of ['manager', 'staff', 'viewer'] as const) {
      const out = applyNavOverrides(sidebar(role), { v: 1, order });
      for (const sec of out) {
        const adminLinks = linksOf(admin, sec.section) ?? [];
        const places = sec.items.map((i) => adminLinks.indexOf(i.href));
        expect(places, `${role} ${sec.section}`).toEqual([...places].sort((a, b) => a - b));
        expect(places, `${role} ${sec.section}`).not.toContain(-1);
      }
    }
  });

  it('a custom link keeps the section it was saved under, old or new', () => {
    const out = applyNavOverrides(sidebar(), {
      v: 1,
      order: { inventory: OLD_INVENTORY },
      custom: [
        // Saved under Inventory before the regroup, pointing at an order page:
        // it stays in Inventory, last.
        {
          id: 'old',
          label: 'Rush orders',
          href: '/dashboard/orders?status=rush',
          section: 'inventory',
          iconName: 'ShoppingCart',
        },
        {
          id: 'f',
          label: 'Carrier',
          href: 'https://carrier.example.com',
          section: 'fulfillment',
          iconName: 'Truck',
        },
        {
          id: 'p',
          label: 'Price list',
          href: '/dashboard/suppliers?tab=prices',
          section: 'purchasing',
          iconName: 'Tags',
        },
        {
          id: 'i',
          label: 'Board pack',
          href: 'https://bi.example.com',
          section: 'insights',
          iconName: 'BarChart3',
        },
      ],
    });
    expect(linksOf(out, 'inventory')?.at(-1)).toBe('/dashboard/orders?status=rush');
    expect(linksOf(out, 'fulfillment')?.at(-1)).toBe('https://carrier.example.com');
    expect(linksOf(out, 'purchasing')?.at(-1)).toBe('/dashboard/suppliers?tab=prices');
    expect(linksOf(out, 'insights')?.at(-1)).toBe('https://bi.example.com');
  });

  it('a custom link in a new section a role has no links in still draws that section, in its place', () => {
    // A viewer has no Insights links of their own.
    const out = applyNavOverrides(sidebar('viewer'), {
      v: 1,
      custom: [
        {
          id: 'i',
          label: 'Board pack',
          href: 'https://bi.example.com',
          section: 'insights',
          iconName: 'BarChart3',
        },
      ],
    });
    expect(out.map((s) => s.section)).toEqual([
      'overview',
      'inventory',
      'fulfillment',
      'purchasing',
      'insights',
      'workspace',
    ]);
    expect(linksOf(out, 'insights')).toEqual(['https://bi.example.com']);
  });

  it('the regroup surfaces nothing: an old list naming a module that is off cannot bring it back', () => {
    const noFulfillment = new Set(
      [...EVERY_MODULE].filter((m) => !['orders', 'rentals', 'bundles', 'returns'].includes(m)),
    );
    const out = applyNavOverrides(
      resolveSurface('web_sidebar', { role: 'admin', enabledModules: noFulfillment }),
      { v: 1, order: { inventory: OLD_INVENTORY, fulfillment: ['/dashboard/orders'] } },
    );
    expect(out.map((s) => s.section)).not.toContain('fulfillment');
    expect(hrefs(out)).not.toContain('/dashboard/orders');
  });
});

describe('orderNavSectionItems', () => {
  const at = (href: string, moduleId: string) => ({ href, moduleId });

  it('places each item by its own href alone, so hiding one never moves the others', () => {
    const items = [
      at('/dashboard/reports', 'reports'),
      at('/dashboard/ai', 'ai'),
      at('/dashboard/insights', 'ai'),
    ];
    const order = { workspace: ['/dashboard/insights', '/dashboard/ai'] };
    expect(orderNavSectionItems('insights', items, order).map((i) => i.href)).toEqual([
      '/dashboard/reports',
      '/dashboard/insights',
      '/dashboard/ai',
    ]);
    for (let skip = 0; skip < items.length; skip += 1) {
      const fewer = items.filter((_, i) => i !== skip);
      const full = orderNavSectionItems('insights', items, order).map((i) => i.href);
      expect(orderNavSectionItems('insights', fewer, order).map((i) => i.href)).toEqual(
        full.filter((h) => h !== items[skip]!.href),
      );
    }
  });

  it('an item no old section held counts as one the first old list does not name', () => {
    const items = [
      at('/dashboard/rentals', 'rentals'),
      at('/dashboard/packing', 'packing'),
      at('/dashboard/orders', 'orders'),
    ];
    expect(
      orderNavSectionItems('fulfillment', items, { inventory: ['/dashboard/orders'] }).map(
        (i) => i.href,
      ),
    ).toEqual(['/dashboard/orders', '/dashboard/rentals', '/dashboard/packing']);
  });

  it('leaves sections the regroup did not create to their own list only', () => {
    const items = [at('/dashboard/schedule', 'schedule'), at('/dashboard/team', 'team')];
    expect(
      orderNavSectionItems('workspace', items, { inventory: ['/dashboard/team'] }).map(
        (i) => i.href,
      ),
    ).toEqual(['/dashboard/schedule', '/dashboard/team']);
  });

  it('never mutates the items it is given', () => {
    const items = [at('/dashboard/rentals', 'rentals'), at('/dashboard/orders', 'orders')];
    const copy = [...items];
    orderNavSectionItems('fulfillment', items, { inventory: ['/dashboard/orders'] });
    expect(items).toEqual(copy);
  });
});

describe('the regroup map matches the registry', () => {
  it('every link in a regrouped section belongs to a module mapped to one of its old sections', () => {
    const wrong: string[] = [];
    for (const def of Object.values(MODULE_REGISTRY)) {
      for (const p of def.placements) {
        const from = NAV_SECTIONS_SPLIT_FROM[p.section];
        if (!from) continue;
        const former = NAV_FORMER_SECTION[def.id];
        if (!former || !from.includes(former)) wrong.push(`${def.id} ${p.surface} ${p.label}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every mapped module now sits only in regrouped sections, and the old keys stay valid', () => {
    for (const [id, former] of Object.entries(NAV_FORMER_SECTION)) {
      const def = MODULE_REGISTRY[id as ModuleId];
      expect(def.placements.length, id).toBeGreaterThan(0);
      for (const p of def.placements)
        expect(NAV_SECTIONS_SPLIT_FROM[p.section], id).toContain(former);
    }
    for (const [section, from] of Object.entries(NAV_SECTIONS_SPLIT_FROM)) {
      expect(SECTION_ORDER, section).toContain(section);
      for (const key of from ?? []) expect(SECTION_ORDER, section).toContain(key);
    }
  });

  // The editor saves an Inventory list of Inventory links only, and no list
  // for a section left in its default order; the next draw must then give that
  // default back. It does only while each regrouped section's default order
  // puts the links from Inventory above the links from Workspace (Reports
  // above AI Assistant and Briefing), as the old sidebar drew them.
  it('old lists that name none of a regrouped section’s links leave its default order, for every role', () => {
    const everyModule = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
    for (const surface of ['web_sidebar', 'mobile_drawer'] as const) {
      for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer'] as const) {
        const base = resolveSurface(surface, { role, enabledModules: everyModule });
        const out = applyNavOverrides(base, {
          v: 1,
          order: { inventory: ['/dashboard/nothing'], workspace: ['/dashboard/nothing'] },
        });
        expect(hrefs(out), `${surface} ${role}`).toEqual(hrefs(base));
      }
    }
  });
});

// --- resolveDashboardWidgets ----------------------------------------------

const ALL_WIDGETS = DASHBOARD_WIDGETS.map((w) => w.id);

describe('resolveDashboardWidgets', () => {
  it('null layout => catalog default order, all visible', () => {
    expect(resolveDashboardWidgets(null, ALL_WIDGETS)).toEqual(ALL_WIDGETS);
  });

  it('garbage layout => default order (fail-closed)', () => {
    expect(resolveDashboardWidgets({ v: 2 } as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(
      ALL_WIDGETS,
    );
    expect(resolveDashboardWidgets({ v: 1 } as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(
      ALL_WIDGETS,
    );
    expect(resolveDashboardWidgets('x' as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(
      ALL_WIDGETS,
    );
  });

  it('honors layout order', () => {
    const layout: DashboardLayout = {
      v: 1,
      widgets: [{ id: 'recent-activity' }, { id: 'stat-row' }, { id: 'get-started' }],
    };
    // listed first in given order, then the rest of the catalog appended visible
    const out = resolveDashboardWidgets(layout, ALL_WIDGETS);
    expect(out.slice(0, 3)).toEqual(['recent-activity', 'stat-row', 'get-started']);
    // all 9 present (no loss)
    expect(new Set(out)).toEqual(new Set(ALL_WIDGETS));
  });

  it('omits hidden widgets', () => {
    const layout: DashboardLayout = {
      v: 1,
      widgets: [{ id: 'stat-row', hidden: true }, { id: 'get-started' }],
    };
    const out = resolveDashboardWidgets(layout, ALL_WIDGETS);
    expect(out).not.toContain('stat-row');
    expect(out).toContain('get-started');
  });

  it('drops ids not in available', () => {
    const layout: DashboardLayout = {
      v: 1,
      widgets: [{ id: 'ghost-widget' }, { id: 'stat-row' }],
    };
    const out = resolveDashboardWidgets(layout, ALL_WIDGETS);
    expect(out).not.toContain('ghost-widget');
    expect(out).toContain('stat-row');
  });

  it('appends a newly-shipped available id missing from a saved layout', () => {
    // Layout saved before 'analytics' shipped — it must still appear, visible.
    const layout: DashboardLayout = {
      v: 1,
      widgets: ALL_WIDGETS.filter((id) => id !== 'analytics').map((id) => ({ id })),
    };
    const out = resolveDashboardWidgets(layout, ALL_WIDGETS);
    expect(out).toContain('analytics');
    expect(out[out.length - 1]).toBe('analytics'); // appended at the end
  });
});
