import { describe, expect, it } from 'vitest';
import { computeModuleChangeSet } from './change-set';
import type { ModuleId } from './registry';

const set = (...ids: ModuleId[]) => new Set<ModuleId>(ids);
const norm = (cs: { moduleId: ModuleId; enabled: boolean }[]) =>
  [...cs].sort((a, b) => a.moduleId.localeCompare(b.moduleId));

describe('computeModuleChangeSet', () => {
  it('enabling a module with a non-core dep cascades the dep on', () => {
    expect(norm(computeModuleChangeSet(set(), 'receiving', true))).toEqual(
      norm([{ moduleId: 'receiving', enabled: true }, { moduleId: 'purchase_orders', enabled: true }]),
    );
  });
  it('enabling a module whose deps are all core only toggles itself', () => {
    expect(computeModuleChangeSet(set(), 'books', true)).toEqual([{ moduleId: 'books', enabled: true }]);
  });
  it('disabling a module cascades its dependents off (transitive)', () => {
    expect(norm(computeModuleChangeSet(set('purchase_orders', 'receiving', 'po_imports'), 'purchase_orders', false))).toEqual(
      norm([
        { moduleId: 'purchase_orders', enabled: false },
        { moduleId: 'receiving', enabled: false },
        { moduleId: 'po_imports', enabled: false },
      ]),
    );
  });
  it('disabling only cascades dependents that are currently enabled', () => {
    expect(norm(computeModuleChangeSet(set('purchase_orders', 'receiving'), 'purchase_orders', false))).toEqual(
      norm([{ moduleId: 'purchase_orders', enabled: false }, { moduleId: 'receiving', enabled: false }]),
    );
  });
  it('disabling ai cascades ai_shelf_scan off', () => {
    expect(norm(computeModuleChangeSet(set('ai', 'ai_shelf_scan'), 'ai', false))).toEqual(
      norm([{ moduleId: 'ai', enabled: false }, { moduleId: 'ai_shelf_scan', enabled: false }]),
    );
  });
  it('is idempotent: no change when already in desired state', () => {
    expect(computeModuleChangeSet(set('orders'), 'orders', true)).toEqual([]);
    expect(computeModuleChangeSet(set(), 'orders', false)).toEqual([]);
  });
  it('never emits a core module', () => {
    const cs = computeModuleChangeSet(set(), 'receiving', true);
    expect(cs.some((c) => c.moduleId === 'inventory')).toBe(false);
  });
  it('enabling does not re-emit a dep that is already on', () => {
    expect(computeModuleChangeSet(set('purchase_orders'), 'receiving', true)).toEqual([
      { moduleId: 'receiving', enabled: true },
    ]);
  });
  it('returns [] when called with a core moduleId (guard boundary)', () => {
    expect(computeModuleChangeSet(set(), 'inventory', false)).toEqual([]);
  });
});
