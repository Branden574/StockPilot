// The linked kit's line on the event page follows the event (B103). Before
// the event is completed it says what completing it will hand out, as it
// always has. Once the event has a distribution (its bundle_distributions row)
// it says what was handed out: the kit, the quantity and the warehouse, from
// that row, and nothing about the future. A completed event that handed
// nothing out (its kit removed in the same save, or a hand-out that never
// happened) shows neither. A completed, handed-out event kept saying "1 kit
// will be distributed from <warehouse> when this event is marked complete."
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  event: {} as Record<string, unknown>,
  bundles: {} as Record<string, { id: string; name: string; sku: string | null }>,
  warehouses: [] as Array<{ id: string; name: string }>,
  bundleReadFails: false,
  warehouseReadFails: false,
}));

// The page's own module is on: the page checks it before it reads (B66).
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
// The real context.ts pulls next/headers and the server Supabase client.
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/schedule', () => ({ updateScheduleEventAction: vi.fn() }));
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: { forCurrentUser: vi.fn(async () => ({ get: vi.fn(async () => h.event) })) },
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: {
    forCurrentUser: vi.fn(async () => ({
      get: vi.fn(async (id: string) => {
        const bundle = h.bundles[id];
        if (h.bundleReadFails || !bundle) throw new Error('Bundle not found');
        return { bundle };
      }),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => {
        if (h.warehouseReadFails) throw new Error('statement timeout');
        return h.warehouses;
      }),
    })),
  },
}));

import ScheduleEventDetailPage from './page';

const EVENT_ID = '5eed0000-0000-4000-8000-0000000000b1';
const KIT = 'b0000000-0000-4000-8000-00000000000a';
const OTHER_KIT = 'b0000000-0000-4000-8000-00000000000b';
const EAST = 'a0000000-0000-4000-8000-00000000000e';
const WEST = 'a0000000-0000-4000-8000-00000000000f';

type Status = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
type Distribution = { bundleId: string; quantity: number; warehouseId: string };

/** An event that names KIT: 2 kits from East Warehouse, as it was saved. */
function event(
  status: Status,
  opts: { kit?: boolean; distribution?: Distribution | null } = {},
): Record<string, unknown> {
  const kit = opts.kit ?? true;
  const distribution = opts.distribution ?? null;
  return {
    id: EVENT_ID,
    title: 'Kit drop',
    status,
    startsAt: '2026-10-20T16:00:00.000Z',
    endsAt: null,
    allDay: false,
    locationText: null,
    warehouseName: null,
    requesterName: null,
    createdByName: null,
    details: null,
    orderRequestId: null,
    bundleId: kit ? KIT : null,
    bundleQuantity: kit ? 2 : null,
    bundleWarehouseId: kit ? EAST : null,
    bundleDistributed: distribution !== null,
    bundleDistribution: distribution,
  };
}

async function renderPage() {
  const ui = await ScheduleEventDetailPage({ params: Promise.resolve({ id: EVENT_ID }) });
  return render(ui);
}

/** The Linked bundle card's text, or null when the page has no such card. */
function kitCard(container: HTMLElement): string | null {
  const heading = screen.queryByText('Linked bundle');
  if (!heading) return null;
  const card = heading.closest('section');
  expect(card, 'the Linked bundle card').not.toBeNull();
  expect(container.contains(card)).toBe(true);
  return (card?.textContent ?? '').replace(/\s+/g, ' ');
}

const FUTURE = /will be distributed|when this event is marked complete|re-complet|re-fire/i;
const HANDED_OUT = /(?:was|were) distributed/;

beforeEach(() => {
  vi.clearAllMocks();
  h.bundles = {
    [KIT]: { id: KIT, name: 'Starter kit', sku: 'KIT-START' },
    [OTHER_KIT]: { id: OTHER_KIT, name: 'Spare kit', sku: 'KIT-SPARE' },
  };
  h.warehouses = [
    { id: EAST, name: 'East Warehouse' },
    { id: WEST, name: 'West Warehouse' },
  ];
  h.bundleReadFails = false;
  h.warehouseReadFails = false;
});

describe("the event page's linked kit line (B103)", () => {
  it.each(['scheduled', 'in_progress', 'cancelled'] as const)(
    'before completion (%s) it keeps the sentence about what completing will hand out',
    async (status) => {
      h.event = event(status);
      const { container } = await renderPage();
      const card = kitCard(container);
      expect(card).toContain(
        '2 kits will be distributed from East Warehouse when this event is marked complete.',
      );
      expect(card).not.toMatch(HANDED_OUT);
      expect(card).toContain('Pending');
    },
  );

  it('once the event has a distribution it says what was handed out and nothing about the future', async () => {
    h.event = event('completed', {
      distribution: { bundleId: KIT, quantity: 1, warehouseId: EAST },
    });
    const { container } = await renderPage();
    const card = kitCard(container);
    expect(card).toContain('1 kit (Starter kit) was distributed from East Warehouse.');
    expect(card).not.toMatch(FUTURE);
    expect(card).toContain('Distributed');
  });

  it("says the distribution row's kit, quantity and warehouse, not the event's plan", async () => {
    // A hand-out from a bundle page, linked to this event, of another kit: the
    // event planned 2 Starter kits from East Warehouse.
    h.event = event('completed', {
      distribution: { bundleId: OTHER_KIT, quantity: 3, warehouseId: WEST },
    });
    const { container } = await renderPage();
    const card = kitCard(container);
    expect(card).toContain('3 kits (Spare kit) were distributed from West Warehouse.');
    expect(card).not.toMatch(FUTURE);
    expect(card).not.toMatch(/East Warehouse/);
  });

  it('a reopened event that already handed out its kit still says what was handed out', async () => {
    h.event = event('scheduled', {
      distribution: { bundleId: KIT, quantity: 2, warehouseId: EAST },
    });
    const { container } = await renderPage();
    const card = kitCard(container);
    expect(card).toContain('2 kits (Starter kit) were distributed from East Warehouse.');
    expect(card).not.toMatch(FUTURE);
  });

  it('an event completed with its kit removed in the same save shows neither', async () => {
    h.event = event('completed', { kit: false });
    const { container } = await renderPage();
    expect(kitCard(container)).toBeNull();
    expect(container.textContent).not.toMatch(FUTURE);
    expect(container.textContent).not.toMatch(HANDED_OUT);
  });

  it('a completed event that kept its kit but handed nothing out shows neither sentence', async () => {
    // A hand-out that was refused at completion, a kit added after the event
    // was completed, or an order that closed its delivery event.
    h.event = event('completed');
    const { container } = await renderPage();
    const card = kitCard(container);
    expect(card).toContain('Starter kit');
    expect(card).toContain('Pending');
    expect(card).not.toMatch(FUTURE);
    expect(card).not.toMatch(HANDED_OUT);
  });

  it('leaves out a kit name it cannot read and says "a warehouse" for a warehouse it cannot read', async () => {
    h.bundleReadFails = true;
    h.warehouseReadFails = true;
    h.event = event('completed', {
      distribution: { bundleId: KIT, quantity: 1, warehouseId: EAST },
    });
    const { container } = await renderPage();
    const card = kitCard(container);
    expect(card).toContain('1 kit was distributed from a warehouse.');
    expect(card).not.toMatch(FUTURE);
  });
});
