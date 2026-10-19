import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { RentalRow } from '@/server/services/rentals';

import { isRentalOverdue } from '@stockpilot/core';

/**
 * A rental's status as the list and the detail page show it: the stored
 * status, except that an out rental past its expected return reads Overdue
 * (core's rule, the one the daily overdue sweep uses). Overdue is derived,
 * never stored.
 */
export type RentalStatusDisplay = 'out' | 'overdue' | 'returned' | 'cancelled';

export function deriveRentalStatus(
  rental: Pick<RentalRow, 'status' | 'expected_return_at'>,
  nowMs: number,
): RentalStatusDisplay {
  if (rental.status === 'returned') return 'returned';
  if (rental.status === 'cancelled') return 'cancelled';
  if (isRentalOverdue(rental, nowMs)) return 'overdue';
  return 'out';
}

export const RENTAL_STATUS_LABELS: Record<RentalStatusDisplay, string> = {
  out: 'Out',
  overdue: 'Overdue',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

/**
 * Each status on one of the six status tones (DESIGN-SPEC 6.10) instead of the
 * old hand-picked blue / red / emerald / gray: Out neutral, Overdue the
 * restrained danger tone, Returned the accent, Cancelled outline. The word is
 * always printed, so colour is never the only cue.
 */
const TONES: Record<RentalStatusDisplay, NonNullable<BadgeProps['variant']>> = {
  out: 'secondary',
  overdue: 'destructive',
  returned: 'success',
  cancelled: 'outline',
};

export function RentalStatusBadge({
  status,
  className,
}: {
  status: RentalStatusDisplay;
  className?: string;
}) {
  return (
    // The status is worked out from the clock on the server and again in the
    // browser, so it can turn Overdue in between (a rental due a minute after
    // the server rendered): that drift is expected, not a hydration error.
    <Badge
      variant={TONES[status]}
      data-rental-status={status}
      className={className}
      suppressHydrationWarning
    >
      {RENTAL_STATUS_LABELS[status]}
    </Badge>
  );
}
