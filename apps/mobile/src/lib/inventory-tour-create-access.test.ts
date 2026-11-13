import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

/**
 * THE INVENTORY TOUR SHOWS THE + STEP ONLY TO A MEMBER WHO SEES THE + (B124).
 *
 * The + on Inventory shows only when the saved access answers 'allowed' for
 * items:create. The tour's step "Add from anywhere" points at it; for anyone
 * else it pointed at nothing and told them about a button they do not have.
 * The tour now leaves that step out for them, and keeps every other step in
 * its order.
 */

const INVENTORY = 'app/(drawer)/(tabs)/inventory.tsx';

describe('inventoryTourFor', () => {
  it('a member who can create items: the tour as it is', async () => {
    const { inventoryTourFor, MOBILE_INVENTORY_TOUR } = await import('./onboarding');
    expect(inventoryTourFor(true)).toBe(MOBILE_INVENTORY_TOUR);
  });

  it('anyone else: the same tour without the + step, every other step in order', async () => {
    const { inventoryTourFor, MOBILE_INVENTORY_TOUR } = await import('./onboarding');
    const tour = inventoryTourFor(false);
    expect(tour.id).toBe(MOBILE_INVENTORY_TOUR.id);
    expect(tour.version).toBe(MOBILE_INVENTORY_TOUR.version);
    expect(tour.steps.map((s) => s.targetId)).toEqual(
      MOBILE_INVENTORY_TOUR.steps.map((s) => s.targetId).filter((t) => t !== 'inventory-add'),
    );
    // The same object every time (the tour measures its steps by identity).
    expect(inventoryTourFor(false)).toBe(tour);
  });

  it('Inventory runs the tour for the member it shows the + to', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', INVENTORY), 'utf8');
    expect(src).toContain('<MobileTour tour={inventoryTourFor(canCreateItems)} />');
  });
});
