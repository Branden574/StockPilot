import { Badge } from '@/components/ui/badge';

const MAP: Record<string, { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'outline', label: 'Draft' },
  expected_inbound: { variant: 'secondary', label: 'Expected' },
  ordered: { variant: 'secondary', label: 'Ordered' },
  partially_received: { variant: 'warning', label: 'Partial' },
  received: { variant: 'success', label: 'Received' },
  cancelled: { variant: 'destructive', label: 'Cancelled' },
};

export function PoStatusBadge({ status }: { status: string }) {
  const cfg = MAP[status] ?? MAP.draft!;
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
