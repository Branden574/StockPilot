import { Badge, type BadgeProps } from '@/components/ui/badge';
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@stockpilot/core';

/**
 * Each status on one of the six status tones (DESIGN-SPEC 6.10), in place of
 * hand-picked palette colours laid over the ink badge (whose hover then turned
 * the pill ink): Saved neutral, the opened draft warning, Resolved success,
 * Archived outline, Cancelled outline and struck through.
 */
const TONES: Record<MaintenanceStatus, NonNullable<BadgeProps['variant']>> = {
  saved: 'secondary',
  draft_opened: 'warning',
  resolved: 'success',
  archived: 'outline',
  cancelled: 'outline',
};

/** Renders the ONLY sanctioned status vocabulary (brief section 20, mirrored
 *  in MAINTENANCE_STATUS_LABELS) — never "sent", "ticket created", or
 *  anything implying a Zendesk-observed outcome StockPilot cannot see. */
export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  return (
    <Badge
      variant={TONES[status] ?? 'outline'}
      className={status === 'cancelled' ? 'line-through' : undefined}
    >
      {MAINTENANCE_STATUS_LABELS[status]}
    </Badge>
  );
}
