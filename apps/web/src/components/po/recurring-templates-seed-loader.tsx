'use client';

import * as React from 'react';

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface Props {
  initial: RecurringTemplateRow[];
  items: ItemOption[];
  suppliers: SupplierOption[];
  locations: LocationOption[];
  entitled: boolean;
}

type Seed = {
  supplierId: string | null;
  destinationLocationId: string | null;
  lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>;
};

/**
 * Thin client wrapper that reads a "recurring-po-seed" from sessionStorage
 * (placed there by MakeRecurringButton on the PO detail page) and passes it
 * to RecurringTemplatesPanel so the create form opens pre-filled. The seed
 * is consumed (deleted) on read so it doesn't persist across navigations.
 */
export function RecurringTemplatesSeedLoader(props: Props) {
  const [seed, setSeed] = React.useState<Seed | null>(null);

  React.useEffect(() => {
    const raw = sessionStorage.getItem('recurring-po-seed');
    if (raw) {
      sessionStorage.removeItem('recurring-po-seed');
      try {
        setSeed(JSON.parse(raw) as Seed);
      } catch {
        // malformed — ignore
      }
    }
  }, []);

  return <RecurringTemplatesPanel {...props} seed={seed} />;
}
