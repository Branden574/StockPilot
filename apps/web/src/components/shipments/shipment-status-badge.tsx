import { Badge } from '@/components/ui/badge';

import type { ShipmentStatus } from '@/server/services/shipments';

const MAP: Record<
  ShipmentStatus,
  { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'; label: string }
> = {
  draft: { variant: 'outline', label: 'Draft' },
  shipped: { variant: 'secondary', label: 'Shipped' },
  delivered: { variant: 'success', label: 'Delivered' },
  cancelled: { variant: 'destructive', label: 'Cancelled' },
};

export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  const cfg = MAP[status] ?? MAP.draft;
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
