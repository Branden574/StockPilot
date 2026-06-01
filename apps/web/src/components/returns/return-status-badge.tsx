import { Badge } from '@/components/ui/badge';

import type { ReturnStatus } from '@/server/services/returns';

/** Visual badge for an RMA lifecycle status. Mirrors the order status badge. */
export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  switch (status) {
    case 'requested':
      return <Badge variant="warning">Requested</Badge>;
    case 'approved':
      return <Badge variant="default">Approved</Badge>;
    case 'received':
      return <Badge variant="secondary">Received</Badge>;
    case 'closed':
      return <Badge variant="success">Closed</Badge>;
    case 'denied':
      return <Badge variant="destructive">Denied</Badge>;
    case 'cancelled':
      return <Badge variant="outline">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

const REASON_LABELS: Record<string, string> = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  end_of_year: 'End of year',
  overage: 'Overage',
  other: 'Other',
};

export function returnReasonLabel(code: string | null): string {
  if (!code) return '—';
  return REASON_LABELS[code] ?? code;
}
