import { beforeEach, describe, expect, it, vi } from 'vitest';

/** L10: the bundle forms refuse a component set that names one item twice. */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(),
}));

const svc = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: { forCurrentUser: vi.fn(async () => svc) },
}));

import { createBundleAction, updateBundleAction } from './bundles';

const A = '11111111-1111-4111-8111-111111111111';
const BUNDLE = '33333333-3333-4333-8333-333333333333';

beforeEach(() => vi.clearAllMocks());

describe('bundle actions: duplicate components', () => {
  it('create refuses one item listed twice', async () => {
    const res = await createBundleAction({
      name: 'Kit',
      components: [
        { itemId: A, quantity: 1 },
        { itemId: A, quantity: 2 },
      ],
    });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'validation_error', message: 'Each item can be in a bundle only once.' },
    });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('update refuses one item listed twice', async () => {
    const res = await updateBundleAction({
      id: BUNDLE,
      components: [
        { itemId: A, quantity: 1 },
        { itemId: A, quantity: 2 },
      ],
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(svc.update).not.toHaveBeenCalled();
  });
});
