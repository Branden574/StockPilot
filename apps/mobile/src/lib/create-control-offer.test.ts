import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { can, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

// screen-access.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));
vi.mock('./supabase', () => ({ supabase: {} }));

/**
 * A CONTROL THAT ONLY LEADS TO A WRITE THE SERVER CHECKS IS OFFERED BY ONE
 * RULE (S75, B124).
 *
 * The + on Inventory and Books, the Scan tab's add cards and the Inventory
 * tour's + step lead only to creating an item, which the server checks with
 * items:create. They are offered (screen-access.ts createControlOffer):
 *   - 'allowed': offered;
 *   - 'denied' (a saved set's answer): hidden;
 *   - 'unknown': hidden, and not settled;
 *   - 'not-synced' and 'unreadable': by the role's default permissions once
 *     the role is known; hidden, and not settled, while it is not.
 * The role's defaults decide nothing a screen reads or shows from the phone;
 * they may still decide whether a create control is offered, because the
 * server checks the write.
 *
 * The Inventory tour starts only once that answer is settled, and keeps the
 * definition it started with while it is open.
 */

const INVENTORY = 'app/(drawer)/(tabs)/inventory.tsx';
const BOOKS = 'app/(drawer)/(tabs)/books.tsx';
const SCAN = 'app/(drawer)/(tabs)/scan.tsx';

const code = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

const ROLES: Role[] = ['viewer', 'staff', 'manager', 'admin', 'owner'];

describe('createControlOffer', () => {
  it("'allowed' offers, 'denied' hides, 'unknown' waits, whatever the role", async () => {
    const { createControlOffer } = await import('./screen-access');
    for (const role of [...ROLES, null]) {
      for (const roleLoading of [false, true]) {
        expect(createControlOffer('allowed', 'items:create', role, roleLoading)).toBe('offered');
        expect(createControlOffer('denied', 'items:create', role, roleLoading)).toBe('hidden');
        expect(createControlOffer('unknown', 'items:create', role, roleLoading)).toBe('pending');
      }
    }
  });

  it("'not-synced' and 'unreadable': the role's defaults once the role is known", async () => {
    const { createControlOffer } = await import('./screen-access');
    for (const access of ['not-synced', 'unreadable'] as const) {
      for (const role of ROLES) {
        expect([access, role, createControlOffer(access, 'items:create', role, false)]).toEqual([
          access,
          role,
          can({ role }, 'items:create') ? 'offered' : 'hidden',
        ]);
        // A role still being read for this workspace is not known.
        expect(createControlOffer(access, 'items:create', role, true)).toBe('pending');
      }
      expect(createControlOffer(access, 'items:create', null, false)).toBe('pending');
    }
  });

  it("a viewer's defaults do not create items, a staff member's do (the rule above is not vacuous)", () => {
    expect(can({ role: 'viewer' }, 'items:create')).toBe(false);
    expect(can({ role: 'staff' }, 'items:create')).toBe(true);
  });

  it('screen-access.ts says where the role still decides', () => {
    const header = readFileSync(path.resolve(__dirname, 'screen-access.ts'), 'utf8').replace(
      /\s*\n\s*\*\s*/g,
      ' ',
    );
    expect(header).toContain(
      "The role's default permissions decide nothing a screen reads or shows from the phone. They may still decide whether a create control is offered (createControlOffer), because the server checks the write.",
    );
  });
});

describe('one helper, used by every create control', () => {
  it.each([INVENTORY, BOOKS, SCAN])('%s', (file) => {
    const src = code(file);
    expect(src).toContain("const createOffer = useCreateControlOffer('items:create');");
    expect(src).toContain("const canCreateItems = createOffer === 'offered';");
    expect(src).not.toContain("usePermissionAccess('items:create')");
  });

  it('useCreateControlOffer asks the saved access and the role, and nothing else', () => {
    const src = code('src/lib/use-screen-access.ts');
    expect(src).toMatch(
      /export function useCreateControlOffer\(permission: Permission\): CreateControlOffer \{ const access = usePermissionAccess\(permission\); const \{ role, loading: roleLoading \} = useRole\(\); return createControlOffer\(access, permission, role, roleLoading\); \}/,
    );
  });
});

describe('the Inventory tour starts once the answer is settled', () => {
  it('nothing while pending; the definition for the answer once settled', async () => {
    const { inventoryTourToShow, inventoryTourFor } = await import('./onboarding');
    expect(inventoryTourToShow(null, 'pending', false)).toBeNull();
    expect(inventoryTourToShow(null, 'offered', false)).toBe(inventoryTourFor(true));
    expect(inventoryTourToShow(null, 'hidden', false)).toBe(inventoryTourFor(false));
  });

  it('while the tour is open, the definition it started with stays', async () => {
    const { inventoryTourToShow, inventoryTourFor } = await import('./onboarding');
    const withAdd = inventoryTourFor(true);
    expect(inventoryTourToShow(withAdd, 'hidden', true)).toBe(withAdd);
    expect(inventoryTourToShow(withAdd, 'pending', true)).toBe(withAdd);
    // Closed, it follows the answer again.
    expect(inventoryTourToShow(withAdd, 'hidden', false)).toBe(inventoryTourFor(false));
    expect(inventoryTourToShow(withAdd, 'pending', false)).toBeNull();
  });

  it('Inventory mounts the tour only with a settled definition', () => {
    const src = code(INVENTORY);
    expect(src).toContain('const tourOpen = useTourVisible(MOBILE_INVENTORY_TOUR.id);');
    expect(src).toContain(
      'const [inventoryTour, setInventoryTour] = React.useState<MobileTourDefinition | null>(null);',
    );
    expect(src).toContain(
      'const nextInventoryTour = inventoryTourToShow(inventoryTour, createOffer, tourOpen);',
    );
    expect(src).toContain(
      'if (nextInventoryTour !== inventoryTour) setInventoryTour(nextInventoryTour);',
    );
    expect(src).toContain('{inventoryTour ? <MobileTour tour={inventoryTour} /> : null}');
    expect(src).not.toContain('<MobileTour tour={inventoryTourFor(canCreateItems)} />');
  });
});
