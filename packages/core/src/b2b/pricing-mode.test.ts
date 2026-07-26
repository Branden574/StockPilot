import { describe, expect, it } from 'vitest';
import { resolvePortalPricingMode } from './pricing-mode';

describe('resolvePortalPricingMode', () => {
  it('defaults to no_charge when there is no setting at all', () => {
    expect(resolvePortalPricingMode(null)).toBe('no_charge');
    expect(resolvePortalPricingMode(undefined)).toBe('no_charge');
    expect(resolvePortalPricingMode({})).toBe('no_charge');
  });

  it('reads an explicit mode', () => {
    expect(resolvePortalPricingMode({ pricingMode: 'priced' })).toBe('priced');
    expect(resolvePortalPricingMode({ pricingMode: 'no_charge' })).toBe('no_charge');
  });

  it('falls back to no_charge for an unrecognised value, never to priced', () => {
    expect(resolvePortalPricingMode({ pricingMode: 'PRICED' })).toBe('no_charge');
    expect(resolvePortalPricingMode({ pricingMode: 42 })).toBe('no_charge');
    expect(resolvePortalPricingMode('priced')).toBe('no_charge');
  });
});
