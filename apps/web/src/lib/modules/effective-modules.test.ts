import { describe, expect, it } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import { effectiveModules, NON_CORE_MODULE_IDS } from './effective-modules';

const rows = (...ids: string[]) => ids.map((module_id) => ({ module_id }));

describe('effectiveModules', () => {
  it('is the explicit rows, and nothing else, for an organization that is not comped', () => {
    expect([...effectiveModules(rows('orders', 'returns'), false)].sort()).toEqual([
      'orders',
      'returns',
    ]);
  });

  it('gives a COMPED organization every non-core module, with no rows at all', () => {
    const got = effectiveModules([], true);
    expect(got.size).toBe(NON_CORE_MODULE_IDS.length);
    for (const id of NON_CORE_MODULE_IDS) expect(got.has(id)).toBe(true);
  });

  it('adds only NON-core modules: core ones are always on and are not its business', () => {
    const core = (Object.values(MODULE_REGISTRY) as Array<{ id: ModuleId; tier: string }>)
      .filter((m) => m.tier === 'core')
      .map((m) => m.id);
    expect(core.length).toBeGreaterThan(0);
    const got = effectiveModules([], true);
    for (const id of core) expect(got.has(id)).toBe(false);
  });

  it('keeps explicit rows alongside the comp', () => {
    // A row the comp does NOT add (a core id, which seed_org_modules writes).
    // With 'orders' here this could not fail: the comp adds 'orders' anyway, so
    // a version that threw the rows away for a comped organization stayed green.
    const got = effectiveModules(rows('inventory'), true);
    expect(got.has('inventory' as ModuleId)).toBe(true);
    expect(got.size).toBe(NON_CORE_MODULE_IDS.length + 1);
  });

  it('grants NOTHING for a flag that is false, null or unknown: an unreadable comp fails closed', () => {
    for (const comped of [false, null, undefined])
      expect([...effectiveModules(rows('orders'), comped)]).toEqual(['orders']);
  });

  it('tolerates a failed rows read', () => {
    expect(effectiveModules(null, false).size).toBe(0);
    expect(effectiveModules(undefined, true).size).toBe(NON_CORE_MODULE_IDS.length);
  });
});
