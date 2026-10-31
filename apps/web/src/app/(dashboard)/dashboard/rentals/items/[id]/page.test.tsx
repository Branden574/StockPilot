import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rental item page: the shared ItemDetail, with what is out on rental
 * (the item's active reservations) read before it renders. A failed read of
 * that number leaves it out rather than failing the page. A link whose id is
 * not a uuid is Page not found before anything is read (B63).
 */
const itemDetail = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));
vi.mock('@/components/inventory/item-detail', () => ({ ItemDetail: itemDetail }));

const reservedQuantityByItemIds = vi.fn(async (_ids: string[]) => new Map<string, number>());
const forCurrentUser = vi.fn(async () => ({ reservedQuantityByItemIds }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: () => forCurrentUser() },
}));

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('notFound');
  },
}));

import RentalItemDetailPage from './page';

const ID = '5eed0000-0000-4000-8000-0000000000a1';

async function open(id = ID, search: { tab?: string; return?: string } = {}) {
  return (await RentalItemDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(search),
  })) as { type: unknown; props: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  reservedQuantityByItemIds.mockResolvedValue(new Map([[ID, 3]]));
});

describe('/dashboard/rentals/items/[id]', () => {
  it('hands ItemDetail the item and what is out on rental', async () => {
    const tree = await open();
    expect(tree.type).toBe(itemDetail);
    expect(tree.props).toMatchObject({
      id: ID,
      backHref: '/dashboard/rentals/items',
      backLabel: 'Back to rental items',
      reservedQuantity: 3,
    });
    expect(reservedQuantityByItemIds).toHaveBeenCalledWith([ID]);
  });

  it('a failed read of what is out on rental leaves the number out, never a failed page', async () => {
    reservedQuantityByItemIds.mockRejectedValue(new Error('gateway timeout'));
    const tree = await open();
    expect(tree.type).toBe(itemDetail);
    expect(tree.props.reservedQuantity).toBeUndefined();
  });

  // B63: a mistyped or cut-off link read the reserved stock with the id (a
  // failed read, quietly dropped) and then ItemDetail's reads crashed the page.
  it('an id that is not a uuid is the not-found page, with nothing read', async () => {
    for (const id of ['not-a-uuid', ID.slice(0, -1)]) {
      await expect(open(id), id).rejects.toBeInstanceOf(NotFound);
    }
    expect(forCurrentUser).not.toHaveBeenCalled();
    expect(reservedQuantityByItemIds).not.toHaveBeenCalled();
  });
});
