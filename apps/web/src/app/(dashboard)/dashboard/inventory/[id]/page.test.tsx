import { describe, expect, it, vi } from 'vitest';

/**
 * The item page route: the browser tab's title (CONFLICTS D16) and what it
 * hands the shared ItemDetail (the validated `?return=`, `?tab=` and the back
 * link's words). ItemDetail itself is tested on its own; here it is a spy.
 */
const itemDetail = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));
vi.mock('@/components/inventory/item-detail', () => ({ ItemDetail: itemDetail }));

import ItemDetailPage, { metadata } from './page';

const ID = '11111111-1111-4111-8111-111111111111';

async function render(search: { tab?: string; return?: string }) {
  const tree = (await ItemDetailPage({
    params: Promise.resolve({ id: ID }),
    searchParams: Promise.resolve(search),
  })) as { type: unknown; props: Record<string, unknown> };
  expect(tree.type).toBe(itemDetail);
  return tree.props;
}

describe('/dashboard/inventory/[id]', () => {
  it('has a title of its own, which the dashboard template makes "Item · StockPilot"', () => {
    expect(metadata.title).toBe('Item');
  });

  it('defaults the back link to the Items list', async () => {
    const props = await render({});
    expect(props).toMatchObject({
      id: ID,
      backHref: '/dashboard/inventory',
      backLabel: 'Back to inventory',
      returnParam: undefined,
    });
    expect(props.editHref).toBeUndefined();
  });

  it('keeps a validated ?return= for the back link and the Edit round trip, and passes ?tab=', async () => {
    const props = await render({ return: '/dashboard/inventory?q=hvac', tab: 'movements' });
    expect(props).toMatchObject({
      backHref: '/dashboard/inventory?q=hvac',
      returnParam: '/dashboard/inventory?q=hvac',
      tab: 'movements',
    });
  });

  it('never trusts a ?return= that leaves the app', async () => {
    for (const bad of ['//evil.example', 'https://evil.example/dashboard']) {
      const props = await render({ return: bad });
      expect(props.backHref).toBe('/dashboard/inventory');
      expect(props.returnParam).toBeUndefined();
    }
  });
});
