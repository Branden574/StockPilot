'use client';

import { Badge } from '@/components/ui/badge';
import { useOrderStatusMeta } from '@/components/orders/order-status-config-provider';

import type { OrderRequestStatus, OrderRequestSummary } from '@/server/services/order-requests';

/**
 * Order status badge. Label + color come from the per-org
 * `OrderStatusConfigProvider` (a SOFT presentation override), which is itself
 * resolved over the canonical `ORDER_STATUS_META` in @stockpilot/core. With no
 * provider mounted the hook falls back to those canonical defaults — so the
 * badge is NEVER blank and NEVER throws. The status VALUE is unchanged; only
 * how it is labeled + colored varies per org.
 */
export function OrderStatusBadge({ status }: { status: OrderRequestStatus }) {
  const meta = useOrderStatusMeta(status);
  return <Badge variant={meta.color}>{meta.label}</Badge>;
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
