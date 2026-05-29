import { describe, expect, it } from 'vitest';
import { resolveSurface } from './resolve';
import { DEFAULT_MODULE_IDS } from './registry';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('resolveSurface', () => {
  it('admin sees the web sidebar including admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/inventory');
    expect(hrefs).toContain('/dashboard/admin');
  });
  it('staff does NOT see admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'staff', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });
  it('disabling an optional module removes its items (core stays)', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: without });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
    expect(hrefs).toContain('/dashboard/inventory');
  });
  it('a core module renders even if absent from enabledModules', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set() });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard');
  });
  it('drops empty sections and sorts by defaultSortOrder', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    expect(out.every((s) => s.items.length > 0)).toBe(true);
    for (const s of out) {
      const orders = s.items.map((i) => i.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
  it('mobile_drawer resolves too (parity)', () => {
    const out = resolveSurface('mobile_drawer', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/inventory');
    expect(hrefs).toContain('/scan');
  });
});
