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

/** 0404: the database builds no kit from a bundle whose components are all
 *  optional, so the forms refuse that set before the service is called. */
describe('bundle actions: at least one required component', () => {
  const B = '22222222-2222-4222-8222-222222222222';
  const NO_REQUIRED =
    'Mark at least one component as required. A kit made only of optional components could be built from nothing.';

  it('create refuses a set whose components are all optional', async () => {
    const res = await createBundleAction({
      name: 'Kit',
      components: [
        { itemId: A, quantity: 1, isOptional: true },
        { itemId: B, quantity: 2, isOptional: true },
      ],
    });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'validation_error', message: NO_REQUIRED },
    });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('update refuses it too', async () => {
    const res = await updateBundleAction({
      id: BUNDLE,
      components: [{ itemId: A, quantity: 1, isOptional: true }],
    });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'validation_error', message: NO_REQUIRED },
    });
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('one required component among optional ones passes to the service', async () => {
    svc.create.mockResolvedValue({ bundle: { id: BUNDLE } });
    const res = await createBundleAction({
      name: 'Kit',
      components: [
        { itemId: A, quantity: 1, isOptional: true },
        { itemId: B, quantity: 2 },
      ],
    });
    expect(res).toMatchObject({ ok: true, data: { id: BUNDLE } });
    expect(svc.create).toHaveBeenCalledTimes(1);
  });
});
