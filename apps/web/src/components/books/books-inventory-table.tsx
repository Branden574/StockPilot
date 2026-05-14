'use client';

import * as React from 'react';

import {
  BooksScanShortcut,
  type BooksScanShortcutHandle,
} from '@/components/books/books-scan-shortcut';
import {
  InventoryTable,
  type InventoryTableProps,
} from '@/components/inventory/inventory-table';

export function BooksInventoryTable(
  props: Omit<InventoryTableProps, 'onScanRequest'>,
) {
  const scanRef = React.useRef<BooksScanShortcutHandle>(null);
  return (
    <>
      <InventoryTable {...props} onScanRequest={() => scanRef.current?.open()} />
      <BooksScanShortcut ref={scanRef} />
    </>
  );
}
