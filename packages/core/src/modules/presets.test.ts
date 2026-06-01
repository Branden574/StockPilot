import { describe, expect, it } from 'vitest';

import { MODULE_REGISTRY, modulesForPack, type DomainPack } from './registry';
import { PACK_PRESETS, PACK_PRESET_LIST, modulesForPreset, presetForPack } from './presets';

const ALL_PACKS: DomainPack[] = [
  'charter_school',
  'distribution',
  'agriculture_food',
  'retail_backroom',
  'light_3pl',
];

describe('PACK_PRESETS', () => {
  it('has a preset for every DomainPack', () => {
    for (const pack of ALL_PACKS) {
      const preset = PACK_PRESETS[pack];
      expect(preset).toBeDefined();
      expect(preset.id).toBe(pack);
      expect(typeof preset.label).toBe('string');
      expect(preset.label.length).toBeGreaterThan(0);
      expect(typeof preset.blurb).toBe('string');
      expect(preset.blurb.length).toBeGreaterThan(0);
    }
  });

  it('presetForPack returns the matching preset (total over the union)', () => {
    for (const pack of ALL_PACKS) {
      expect(presetForPack(pack).id).toBe(pack);
    }
  });

  it('PACK_PRESET_LIST covers exactly the five packs', () => {
    expect(PACK_PRESET_LIST.map((p) => p.id).sort()).toEqual([...ALL_PACKS].sort());
  });

  it('every pack maps to a NON-EMPTY module set (and modulesForPreset matches the registry)', () => {
    for (const pack of ALL_PACKS) {
      const mods = modulesForPack(pack);
      expect(mods.length).toBeGreaterThan(0);
      // Core modules are always present in every pack set.
      expect(mods).toContain('overview');
      expect(mods).toContain('inventory');
      // modulesForPreset is just a passthrough to the registry — must match.
      expect(modulesForPreset(pack).sort()).toEqual(mods.slice().sort());
    }
  });

  it('preset terminology only references real OrgTerminology keys', () => {
    const validKeys = new Set([
      'charter_singular',
      'charter_plural',
      'warehouse_singular',
      'warehouse_plural',
    ]);
    for (const pack of ALL_PACKS) {
      const term = PACK_PRESETS[pack].terminology ?? {};
      for (const key of Object.keys(term)) {
        expect(validKeys.has(key)).toBe(true);
        expect(typeof (term as Record<string, unknown>)[key]).toBe('string');
      }
    }
  });

  it('charter_school preset enables the books + rentals modules (sanity vs registry)', () => {
    const mods = modulesForPack('charter_school');
    expect(mods).toContain('books');
    expect(mods).toContain('rentals');
    // and books is a real registry module
    expect(MODULE_REGISTRY.books.defaultOnFor).toContain('charter_school');
  });
});
