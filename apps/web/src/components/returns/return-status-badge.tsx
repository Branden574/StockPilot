import { Badge } from '@/components/ui/badge';

import type { ReturnStatus } from '@/server/services/returns';

/** Visual badge for an RMA lifecycle status. Mirrors the order status badge. */
export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  switch (status) {
    case 'requested':
      return (
        <Badge variant="warning" data-glass-role="status" data-glass-state={status}>
          Requested
        </Badge>
      );
    case 'approved':
      return (
        <Badge variant="default" data-glass-role="status" data-glass-state={status}>
          Approved
        </Badge>
      );
    case 'received':
      return (
        <Badge variant="secondary" data-glass-role="status" data-glass-state={status}>
          Received
        </Badge>
      );
    case 'closed':
      return (
        <Badge variant="success" data-glass-role="status" data-glass-state={status}>
          Closed
        </Badge>
      );
    case 'denied':
      return (
        <Badge variant="destructive" data-glass-role="status" data-glass-state={status}>
          Denied
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" data-glass-role="status" data-glass-state={status}>
          Cancelled
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" data-glass-role="status" data-glass-state={status}>
          {status}
        </Badge>
      );
  }
}

// The reason labels live in core (`order-returns-view.ts`) so the order page,
// this returns UI and the phone print the same words for the same code.
export { returnReasonLabel } from '@stockpilot/core';
