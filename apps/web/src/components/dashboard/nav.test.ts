import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_IDS, MODULE_REGISTRY } from '@stockpilot/core';

import { NAV_ICONS } from './icons';
import { DASHBOARD_NAV_HREFS, navForRole } from './nav';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('dashboard navigation', () => {
  it('admin sees the full href set with all modules enabled (superset, unique)', () => {
    const adminHrefs = navForRole('admin', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(adminHrefs).size).toBe(adminHrefs.length);
    for (const href of DASHBOARD_NAV_HREFS) expect(adminHrefs).toContain(href);
  });

  it('omits admin section for non-admin roles', () => {
    const staffHrefs = navForRole('staff', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(staffHrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });

  it('disabling rentals removes it from the sidebar', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const hrefs = navForRole('admin', without).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
  });

  it('NAV_ICONS covers every web_sidebar placement icon (no silent Boxes fallback)', () => {
    const used = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY))
      for (const p of def.placements)
        if (p.surface === 'web_sidebar') used.add(p.iconName);
    for (const name of used) expect(NAV_ICONS[name]).toBeDefined();
  });

  // ── Per-org overrides (Phase 2 T2) ──────────────────────────────────────
  // navForRole(role, modules, overrides) applies hide/rename/reorder and
  // appends validated custom links AFTER resolveSurface. It must never surface
  // a disabled module and must drop an unsafe custom href.

  it('applies an override that HIDES an item from the derived nav', () => {
    const baseHrefs = navForRole('admin', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(baseHrefs).toContain('/dashboard/inventory');

    const hrefs = navForRole('admin', ALL, { v: 1, hidden: ['/dashboard/inventory'] }).flatMap(
      (s) => s.items.map((i) => i.href),
    );
    expect(hrefs).not.toContain('/dashboard/inventory');
  });

  it('applies an override that RENAMES an item', () => {
    const sections = navForRole('admin', ALL, {
      v: 1,
      labels: { '/dashboard/inventory': 'Stock' },
    });
    const item = sections.flatMap((s) => s.items).find((i) => i.href === '/dashboard/inventory');
    expect(item?.label).toBe('Stock');
  });

  it('applies an override that REORDERS items within a section', () => {
    // Find a base section with >= 2 items so a reorder is observable, then pull
    // its last item to the front. We don't have the section key on NavSection,
    // so we request the same front-href across every section key —
    // applyNavOverrides ignores hrefs that don't match a section's items.
    const base = navForRole('admin', ALL);
    const multi = base.find((s) => s.items.length >= 2)!;
    const last = multi.items[multi.items.length - 1]!.href;
    const order = {
      overview: [last],
      inventory: [last],
      workspace: [last],
      tools: [last],
      admin: [last],
    };
    const after = navForRole('admin', ALL, { v: 1, order });
    const afterMulti = after.find((s) => s.items.some((i) => i.href === last))!;
    expect(afterMulti.items[0]!.href).toBe(last);
  });

  it('appends a valid custom link and resolves its icon', () => {
    const sections = navForRole('admin', ALL, {
      v: 1,
      custom: [
        {
          id: 'help',
          label: 'Help center',
          href: '/dashboard/help',
          section: 'tools',
          iconName: 'BookOpen',
        },
      ],
    });
    const item = sections.flatMap((s) => s.items).find((i) => i.href === '/dashboard/help');
    expect(item).toBeDefined();
    expect(item?.label).toBe('Help center');
    // Resolves to the chosen lucide component (not the Boxes fallback's identity
    // unless BookOpen IS Boxes — they're distinct in lucide).
    expect(item?.icon).toBe(NAV_ICONS.BookOpen);
  });

  it('DROPS a custom link with a javascript: href (unsafe)', () => {
    const sections = navForRole('admin', ALL, {
      v: 1,
      custom: [
        {
          id: 'evil',
          label: 'Evil',
          // eslint-disable-next-line no-script-url
          href: 'javascript:alert(1)',
          section: 'tools',
          iconName: 'BookOpen',
        },
      ],
    });
    const labels = sections.flatMap((s) => s.items).map((i) => i.label);
    expect(labels).not.toContain('Evil');
  });

  it('fails CLOSED to the derived nav on garbage / null overrides', () => {
    const base = navForRole('admin', ALL).flatMap((s) => s.items.map((i) => i.href));
    const withNull = navForRole('admin', ALL, null).flatMap((s) => s.items.map((i) => i.href));
    // @ts-expect-error — intentionally malformed override to prove fail-closed.
    const withGarbage = navForRole('admin', ALL, { not: 'valid' }).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(withNull).toEqual(base);
    expect(withGarbage).toEqual(base);
  });

  it('override CANNOT surface nav for a disabled module', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    // Try to "un-hide"/order rentals back in via overrides — impossible.
    const hrefs = navForRole('admin', without, {
      v: 1,
      order: { workspace: ['/dashboard/rentals'] },
      labels: { '/dashboard/rentals': 'Rentals' },
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
  });
});
