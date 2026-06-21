'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { ItemCombobox, type ComboboxItem } from '@/components/inventory/item-combobox';

interface ItemCostHistorySearchProps {
  items: ComboboxItem[];
  selectedItemId: string | null;
}

/**
 * Client entry point for the item-cost-history report picker.
 * Renders an ItemCombobox; on selection navigates to
 * /dashboard/reports/item-cost-history?itemId=<id>, preserving any
 * existing since/until query params so switching items keeps the date window.
 */
export function ItemCostHistorySearch({ items, selectedItemId }: ItemCostHistorySearchProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(id: string | null) {
    if (!id) return;
    const params = new URLSearchParams();
    params.set('itemId', id);
    const since = searchParams.get('since');
    const until = searchParams.get('until');
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    router.push(`/dashboard/reports/item-cost-history?${params.toString()}`);
  }

  return (
    <div className="max-w-xl">
      <ItemCombobox
        items={items}
        value={selectedItemId}
        onChange={handleChange}
        placeholder="Search by SKU or name…"
        clearable={false}
      />
    </div>
  );
}
