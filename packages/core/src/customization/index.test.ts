import { describe, expect, it } from 'vitest';
import {
  applyNavOverrides,
  DASHBOARD_WIDGETS,
  isSafeNavHref,
  resolveDashboardWidgets,
  type NavOverrides,
  type DashboardLayout,
} from './index';
import type { ResolvedNavItem, ResolvedNavSection } from '../modules/resolve';

// --- helpers ---------------------------------------------------------------

function item(href: string, label: string, partial: Partial<ResolvedNavItem> = {}): ResolvedNavItem {
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
    const inv = out.find((s) => s.section === 'inventory')!.items.find((i) => i.href === '/dashboard/inventory')!;
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
        { id: 'wiki', label: 'Team Wiki', href: 'https://wiki.example.com', section: 'tools', iconName: 'BookOpen' },
        { id: 'sop', label: 'SOPs', href: '/dashboard/inventory/sops', section: 'inventory', iconName: 'FileText' },
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

// --- resolveDashboardWidgets ----------------------------------------------

const ALL_WIDGETS = DASHBOARD_WIDGETS.map((w) => w.id);

describe('resolveDashboardWidgets', () => {
  it('null layout => catalog default order, all visible', () => {
    expect(resolveDashboardWidgets(null, ALL_WIDGETS)).toEqual(ALL_WIDGETS);
  });

  it('garbage layout => default order (fail-closed)', () => {
    expect(resolveDashboardWidgets({ v: 2 } as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(ALL_WIDGETS);
    expect(resolveDashboardWidgets({ v: 1 } as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(ALL_WIDGETS);
    expect(resolveDashboardWidgets('x' as unknown as DashboardLayout, ALL_WIDGETS)).toEqual(ALL_WIDGETS);
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
