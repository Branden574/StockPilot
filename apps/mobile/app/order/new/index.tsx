import * as React from 'react';

import { CatalogScreen } from '@/components/order-storefront/catalog-screen';

/**
 * PLACE AN ORDER (phone ordering PO-4): the storefront's home, reached from
 * the Orders list's "+" and its empty state, and from a web link to
 * /dashboard/orders/new (web-path-rewrite.ts; the cold-start shim
 * app/dashboard/orders/new.tsx). Static, so /order/new never reaches the
 * order/[id] screen with id "new" (audit D9). The screen is
 * components/order-storefront/catalog-screen.tsx; every rule it applies is in
 * src/lib/order-storefront (tested), pinned by order-storefront-wiring.test.ts.
 */
export default function PlaceAnOrder() {
  return <CatalogScreen target={null} />;
}
