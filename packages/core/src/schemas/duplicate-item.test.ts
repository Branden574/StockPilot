import { describe, expect, it } from 'vitest';

import { duplicateItemAsProductSchema } from './duplicate-item';
import { SIZE_SYSTEMS } from './sports';

const BASE = {
  originalId: '11111111-1111-1111-1111-111111111111',
  itemType: 'product' as const,
  rackNumber: '22',
  quantity: 1,
};

/**
 * `variantSizeSystem` was free text capped at 32 characters here while every
 * OTHER path — the item form, the sized-variant fan-out, the PO-import matcher,
 * the group-linking review — parses it against the SIZE_SYSTEMS enum. A
 * duplicate could therefore stamp a system no picker offers and no other writer
 * would ever produce ('us mens', 'mens', 'US-MENS'), and because
 * `variant_size_system` participates in `variant_key`, that row's identity
 * became unreachable from every other path.
 */
describe('duplicateItemSchema — variantSizeSystem is the shared vocabulary', () => {
  it('accepts every member of SIZE_SYSTEMS', () => {
    for (const system of SIZE_SYSTEMS) {
      const parsed = duplicateItemAsProductSchema.safeParse({
        ...BASE,
        variantSizeSystem: system,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('REFUSES free text that is not a known size system', () => {
    for (const bad of ['us mens', 'US-MENS', 'mens', 'whatever']) {
      const parsed = duplicateItemAsProductSchema.safeParse({
        ...BASE,
        variantSizeSystem: bad,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('still distinguishes ABSENT (inherit) from NULL (clear)', () => {
    // The 0299 RPC contract: `p_overrides ? 'key'` decides inherit vs clear, so
    // the schema must keep both states expressible.
    const inherit = duplicateItemAsProductSchema.safeParse({ ...BASE });
    expect(inherit.success).toBe(true);
    expect(inherit.success && 'variantSizeSystem' in inherit.data).toBe(false);

    const clear = duplicateItemAsProductSchema.safeParse({
      ...BASE,
      variantSizeSystem: null,
    });
    expect(clear.success).toBe(true);
    expect(clear.success && clear.data.variantSizeSystem).toBeNull();
  });
});
