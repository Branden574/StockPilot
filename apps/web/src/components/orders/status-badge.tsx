import { Badge } from '@/components/ui/badge';

import type { OrderRequestStatus, OrderRequestSummary } from '@/server/services/order-requests';

export function OrderStatusBadge({ status }: { status: OrderRequestStatus }) {
  switch (status) {
    case 'pending_approval':
      return <Badge variant="warning">Pending</Badge>;
    case 'approved':
      return <Badge variant="default">Approved</Badge>;
    case 'packaging':
      return <Badge variant="secondary">Packaging</Badge>;
    case 'ready_for_delivery':
      return <Badge variant="secondary">Ready</Badge>;
    case 'delivered':
      return <Badge variant="success">Delivered</Badge>;
    case 'denied':
      return <Badge variant="destructive">Denied</Badge>;
    case 'cancelled':
      return <Badge variant="outline">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function summaryRequesterLabel(r: OrderRequestSummary): string {
  if (r.requesterName) {
    return r.requesterOrgLabel
      ? `${r.requesterName} · ${r.requesterOrgLabel}`
      : r.requesterName;
  }
  if (r.requesterEmail) return r.requesterEmail;
  if (r.requesterUserId) return 'Team member';
  return 'External requester';
}
