import { Badge } from '@/components/ui/badge';
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@stockpilot/core';

const VARIANTS: Record<MaintenanceStatus, string> = {
  saved: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  draft_opened: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  archived: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

/** Renders the ONLY sanctioned status vocabulary (brief section 20, mirrored
 *  in MAINTENANCE_STATUS_LABELS) — never "sent", "ticket created", or
 *  anything implying a Zendesk-observed outcome StockPilot cannot see. */
export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  return <Badge className={VARIANTS[status]}>{MAINTENANCE_STATUS_LABELS[status]}</Badge>;
}
