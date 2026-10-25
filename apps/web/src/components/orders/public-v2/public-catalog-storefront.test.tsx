import { render } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public page hands the browser the compact catalog the data cache holds
 * (catalog-index.ts), not a list of item objects: a tuple per item and each
 * category label once, so the page stays as small as the cached value (B32,
 * integrator decision 3). The storefront's client wrapper expands it.
 *
 * Each row's stock means what the link's display mode said when the rows were
 * built, and that mode travels with the rows: the page's own copy of the link
 * is cached apart, so after a mode change the two could disagree for a
 * minute, and a bucket level (0, 1 or 2) would read as an exact count.
 */

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('./public-orders-v2', () => ({
  PublicOrdersV2: (props: Record<string, unknown>) => {
    captured.props = props;
    return null;
  },
}));

import type { PublicCatalogIndex } from './catalog-index';
import { PublicCatalogStorefront } from './public-catalog-storefront';

const CATALOG: PublicCatalogIndex = {
  mode: 'bucket',
  categories: [['cat-1', 'Art']],
  rows: [
    ['i-1', 'Colored Pencils', 0, 2, 40, null],
    ['i-2', 'Glitter Glue', -1, 1, null, 'https://covers.example.test/glue.jpg'],
    ['i-3', 'Safety Scissors', 0, 0, null, null],
  ],
  cut: false,
};

const OTHER = {
  token: 'tok-1',
  orgName: 'Demo Co',
  warehouses: [{ id: 'wh-n', name: 'North DC' }],
  initialWarehouseId: 'wh-n',
  chartersForWarehouse: [{ id: 'site-1', name: 'Harbor Site', code: 'HS' }],
};

beforeEach(() => {
  captured.props = null;
});

describe('PublicCatalogStorefront', () => {
  it('expands the rows into items, in the catalog’s order, with no lazy field yet', () => {
    render(<PublicCatalogStorefront {...OTHER} catalog={CATALOG} />);
    expect(captured.props?.availabilityDisplay).toBe('bucket');
    expect(captured.props?.items).toEqual([
      {
        id: 'i-1',
        displayName: 'Colored Pencils',
        publicDescription: null,
        categoryId: 'cat-1',
        categoryLabel: 'Art',
        imageUrl: null,
        lqip: null,
        availability: { kind: 'bucket', level: 'in_stock' },
        maxQty: 40,
      },
      {
        id: 'i-2',
        displayName: 'Glitter Glue',
        publicDescription: null,
        categoryId: null,
        categoryLabel: null,
        imageUrl: 'https://covers.example.test/glue.jpg',
        lqip: null,
        availability: { kind: 'bucket', level: 'low_stock' },
        maxQty: null,
      },
      {
        id: 'i-3',
        displayName: 'Safety Scissors',
        publicDescription: null,
        categoryId: 'cat-1',
        categoryLabel: 'Art',
        imageUrl: null,
        lqip: null,
        availability: { kind: 'bucket', level: 'out_of_stock' },
        maxQty: null,
      },
    ]);
  });

  // Mutation caught: the storefront told another mode than the rows were
  // built in (the link's own cached copy).
  it('hands the storefront the catalog’s own display mode, and every other prop as it is', () => {
    render(<PublicCatalogStorefront {...OTHER} catalog={{ ...CATALOG, mode: 'exact' }} />);
    expect(captured.props?.availabilityDisplay).toBe('exact');
    expect((captured.props?.items as Array<{ availability: unknown }>)[0]?.availability).toEqual({
      kind: 'exact',
      count: 2,
    });
    const { items: _items, availabilityDisplay: _mode, ...rest } = captured.props!;
    expect(rest).toEqual(OTHER);
  });

  it('a link that shows no stock: no stock on any item', () => {
    render(
      <PublicCatalogStorefront
        {...OTHER}
        catalog={{
          ...CATALOG,
          mode: 'none',
          rows: CATALOG.rows.map((r) => [r[0], r[1], r[2], null, r[4], r[5]]),
        }}
      />,
    );
    expect(captured.props?.availabilityDisplay).toBe('none');
    for (const it of captured.props?.items as Array<{ availability: unknown }>) {
      expect(it.availability).toEqual({ kind: 'none' });
    }
  });
});
