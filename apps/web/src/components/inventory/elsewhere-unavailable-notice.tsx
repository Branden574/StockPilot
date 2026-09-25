import * as React from 'react';

import { ELSEWHERE_UNAVAILABLE_NOTE } from '@stockpilot/core';

/**
 * A list of items whose placement figures were built WITHOUT the stock in
 * other warehouses, because that read failed (0371,
 * InventoryService.list's `elsewhereUnavailable`). The figures then cover the
 * viewer's own warehouses only, and the page must say so rather than present
 * them as complete: this renders the list with the shared note above it.
 * Nothing is added when the read succeeded, or on the manager path (which
 * sees every holding and never sets the flag).
 *
 * Shared by the Items, Books and Rentals item lists so none of them can drop
 * the note on its own. No directive: server pages render it directly.
 */
export function ElsewhereUnavailableNotice({
  unavailable,
  children,
}: {
  unavailable: boolean | undefined;
  children: React.ReactNode;
}) {
  if (!unavailable) return <>{children}</>;
  return (
    <>
      <p role="status" className="text-muted-foreground mb-2 text-xs">
        {ELSEWHERE_UNAVAILABLE_NOTE}
      </p>
      {children}
    </>
  );
}
