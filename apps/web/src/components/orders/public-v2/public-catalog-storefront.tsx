'use client';

// The public order page's storefront, from the compact catalog (B32,
// integrator decision 3). The page hands the browser the catalog as the data
// cache holds it (catalog-index.ts: a tuple per item, each category label
// once), so the page is no larger than the cached value; this wrapper expands
// it into the items the storefront draws. Each row's stock is read in the
// catalog's own display mode, and the storefront is told that mode, so the
// two never disagree.

import * as React from 'react';

import { expandPublicCatalog, type PublicCatalogIndex } from './catalog-index';
import { PublicOrdersV2, type PublicOrdersV2Props } from './public-orders-v2';

export interface PublicCatalogStorefrontProps extends Omit<
  PublicOrdersV2Props,
  'items' | 'availabilityDisplay'
> {
  catalog: PublicCatalogIndex;
}

export function PublicCatalogStorefront({ catalog, ...rest }: PublicCatalogStorefrontProps) {
  const items = React.useMemo(() => expandPublicCatalog(catalog), [catalog]);
  return <PublicOrdersV2 {...rest} items={items} availabilityDisplay={catalog.mode} />;
}
