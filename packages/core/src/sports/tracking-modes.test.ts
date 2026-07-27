import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBCATEGORY_PROFILES,
  SPORTS_ERROR_CODES,
  SPORTS_ERROR_META,
  SPORTS_SUBCATEGORIES,
  TRACKING_MODES,
  countingUnitLabel,
  modeHasVariants,
  trackingTypeForMode,
} from './tracking-modes';

describe('trackingTypeForMode', () => {
  it('maps every mode to a legal tracking_type', () => {
    for (const m of TRACKING_MODES) {
      expect(['none', 'lot', 'serial', 'serial_optional']).toContain(trackingTypeForMode(m));
    }
  });

  it('keeps quantity-shaped modes off serials entirely', () => {
    expect(trackingTypeForMode('QUANTITY')).toBe('none');
    expect(trackingTypeForMode('QUANTITY_BY_VARIANT')).toBe('none');
    expect(trackingTypeForMode('NUMBERED_VARIANT')).toBe('none');
  });

  it('keeps SERIALIZED strict (R1: Electronics is unaffected)', () => {
    expect(trackingTypeForMode('SERIALIZED')).toBe('serial');
    expect(trackingTypeForMode('INDIVIDUALLY_TAGGED')).toBe('serial');
  });

  it('routes OPTIONAL_SERIALIZED to the new relaxed value', () => {
    expect(trackingTypeForMode('OPTIONAL_SERIALIZED')).toBe('serial_optional');
  });
});

describe('DEFAULT_SUBCATEGORY_PROFILES', () => {
  it('covers every subcategory key', () => {
    for (const k of SPORTS_SUBCATEGORIES) {
      expect(DEFAULT_SUBCATEGORY_PROFILES[k]).toBeTruthy();
      expect(DEFAULT_SUBCATEGORY_PROFILES[k].key).toBe(k);
    }
  });

  it('always lists the default mode among the allowed modes', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      expect(p.allowedModes).toContain(p.defaultMode);
    }
  });

  it('never requires an attribute it does not support', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      for (const a of p.requiredAttributes) expect(p.supportedAttributes).toContain(a);
    }
  });

  it('defaults shoes to per-variant quantity counted in pairs', () => {
    const shoes = DEFAULT_SUBCATEGORY_PROFILES.shoes;
    expect(shoes.defaultMode).toBe('QUANTITY_BY_VARIANT');
    expect(shoes.defaultCountingUnit).toBe('pair');
    expect(shoes.supportsNumbers).toBe(false);
    expect(shoes.requiredAttributes).toEqual(['size', 'size_system']);
  });

  it('defaults jerseys to numbered variants that support numbers', () => {
    const j = DEFAULT_SUBCATEGORY_PROFILES.jerseys;
    expect(j.defaultMode).toBe('NUMBERED_VARIANT');
    expect(j.supportsNumbers).toBe(true);
    expect(j.supportedAttributes).toContain('jersey_number');
  });

  it('only allows individual tracking where the profile says so', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      if (!p.individualTrackingAllowed) {
        expect(p.allowedModes).not.toContain('INDIVIDUALLY_TAGGED');
      }
    }
  });
});

describe('modeHasVariants', () => {
  it('is true only for the two variant modes', () => {
    expect(modeHasVariants('QUANTITY_BY_VARIANT')).toBe(true);
    expect(modeHasVariants('NUMBERED_VARIANT')).toBe(true);
    expect(modeHasVariants('QUANTITY')).toBe(false);
    expect(modeHasVariants('SERIALIZED')).toBe(false);
  });
});

describe('countingUnitLabel', () => {
  it('pluralizes pair as the display convention (never a conversion)', () => {
    expect(countingUnitLabel('pair', 12)).toBe('pairs');
    expect(countingUnitLabel('pair', 1)).toBe('pair');
    expect(countingUnitLabel('each', 12)).toBe('each');
  });
});

describe('SPORTS_ERROR_META', () => {
  it('has meta for every code', () => {
    for (const c of SPORTS_ERROR_CODES) {
      const m = SPORTS_ERROR_META[c];
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.action.length).toBeGreaterThan(0);
    }
  });
});
