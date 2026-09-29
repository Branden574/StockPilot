import * as React from 'react';

import { bookReportIdentityParts } from '@stockpilot/core';

/**
 * A book's identity line ('SKU BK-A · ISBN 978-0-14-044913-6 · DC4 · Rack
 * 12-B') laid out so a narrow column breaks it only between pieces: an SKU,
 * ISBN/Barcode or rack label is kept whole (a browser otherwise breaks
 * 'ISBN 978-0-' over '14-044913-6' at a hyphen), while a warehouse name may
 * wrap. The text is exactly formatBookReportIdentityLine's. Renders nothing
 * for a record with none of them.
 */
export function BookIdentityLine({
  row,
  className,
}: {
  row: {
    sku: string | null;
    identifier: string | null;
    warehouseName: string | null;
    binLocation: string | null;
  };
  className?: string;
}) {
  const parts = bookReportIdentityParts(row);
  if (parts.length === 0) return null;
  return (
    <span className={className} data-book-identity="">
      {parts.map((part, i) => (
        <React.Fragment key={part.kind}>
          {i > 0 ? ' · ' : null}
          <span
            data-part={part.kind}
            className={part.kind === 'warehouse' ? undefined : 'whitespace-nowrap tabular-nums'}
          >
            {part.text}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}
