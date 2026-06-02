'use client';

import { Badge } from '@/components/ui/badge';
import { useOrderStatusMeta } from '@/components/orders/order-status-config-provider';

import type { OrderRequestStatus } from '@/server/services/order-requests';

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

// NOTE: `summaryRequesterLabel` moved to ./requester-label (a server-safe,
// non-'use client' module). It's a plain function the orders list Server
// Component calls directly, and exporting it from THIS client module turned it
// into a client reference that threw "Attempted to call summaryRequesterLabel()
// from the server" on any populated orders tab. Keep server-called helpers out
// of 'use client' files.
