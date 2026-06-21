'use client';

import { useRouter } from 'next/navigation';
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
 * existing since/until query params.
 */
export function ItemCostHistorySearch({ items, selectedItemId }: ItemCostHistorySearchProps) {
  const router = useRouter();

  function handleChange(id: string | null) {
    if (!id) return;
    router.push(`/dashboard/reports/item-cost-history?itemId=${encodeURIComponent(id)}`);
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
