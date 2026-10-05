import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { CatalogScreen } from '@/components/order-storefront/catalog-screen';
import { browseTargetFromParams } from '@/lib/order-storefront/sections';

/**
 * One part of the storefront (phone ordering PO-4): a category, or "See all"
 * for a home section (Frequently ordered, Kits) or All items. The same screen
 * as the home, listing that part's items, searched on the phone over every
 * row.
 */
export default function BrowseOrderItems() {
  const params = useLocalSearchParams<{ category?: string; section?: string }>();
  const target = React.useMemo(
    () => browseTargetFromParams({ category: params.category, section: params.section }),
    [params.category, params.section],
  );
  return <CatalogScreen target={target} />;
}
