import { describe, expect, it } from 'vitest';
import { MODULE_REGISTRY, DEFAULT_MODULE_IDS, modulesForPack, type ModuleId } from './registry';

describe('MODULE_REGISTRY', () => {
  it('every module id matches its record key', () => {
    for (const [key, def] of Object.entries(MODULE_REGISTRY)) expect(def.id).toBe(key);
  });
  it('dependsOn references only known modules and is acyclic', () => {
    const ids = new Set(Object.keys(MODULE_REGISTRY));
    for (const def of Object.values(MODULE_REGISTRY))
      for (const dep of def.dependsOn) expect(ids.has(dep)).toBe(true);
    const seenGlobal = new Set<string>();
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new Error(`cycle through ${id}`);
      if (seenGlobal.has(id)) return;
      stack.add(id);
      for (const d of MODULE_REGISTRY[id as ModuleId].dependsOn) visit(d, stack);
      stack.delete(id); seenGlobal.add(id);
    };
    expect(() => Object.keys(MODULE_REGISTRY).forEach((id) => visit(id, new Set()))).not.toThrow();
  });
  it('every nav placement href is unique per surface', () => {
    const seen = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY))
      for (const p of def.placements) {
        const k = `${p.surface}:${p.href}`;
        expect(seen.has(k)).toBe(false); seen.add(k);
      }
  });
  it('DEFAULT_MODULE_IDS = the charter pack set and includes every core module', () => {
    const core = Object.values(MODULE_REGISTRY).filter((m) => m.tier === 'core').map((m) => m.id);
    for (const id of core) expect(DEFAULT_MODULE_IDS).toContain(id);
    expect(modulesForPack('charter_school').sort()).toEqual([...DEFAULT_MODULE_IDS].sort());
  });
  it('covers the current web sidebar hrefs', () => {
    const webHrefs = Object.values(MODULE_REGISTRY).flatMap((m) => m.placements)
      .filter((p) => p.surface === 'web_sidebar').map((p) => p.href);
    for (const href of [
      '/dashboard','/dashboard/inventory','/dashboard/books','/dashboard/categories',
      '/dashboard/tags','/dashboard/movements','/dashboard/rentals','/dashboard/bundles',
      '/dashboard/orders','/dashboard/cycle-counts','/dashboard/procedures',
      '/dashboard/purchase-orders','/dashboard/purchase-orders/imports','/dashboard/locations',
      '/dashboard/suppliers','/dashboard/reports','/dashboard/ai','/dashboard/schedule',
      '/dashboard/notifications','/dashboard/team','/dashboard/settings',
      '/dashboard/admin','/dashboard/admin/charters','/dashboard/admin/warehouses',
      '/dashboard/admin/bins','/dashboard/admin/users','/dashboard/admin/vendor-mappings',
      '/dashboard/admin/uom-conversions','/dashboard/admin/reconciliation','/dashboard/admin/audit',
    ]) expect(webHrefs).toContain(href);
  });
});
