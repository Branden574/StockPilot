import { Badge } from '@/components/ui/badge';

import { CYCLE_COUNT_STATUS_LABELS, type CycleCountStatusValue } from '@stockpilot/core';

/** The Badge tone each count status takes (DESIGN-SPEC 6.10: In progress
 *  amber, Completed accent, Canceled danger). */
const TONE: Record<CycleCountStatusValue, 'warning' | 'success' | 'destructive'> = {
  in_progress: 'warning',
  completed: 'success',
  canceled: 'destructive',
};

/** The Badge variant for a status; a status this build does not know takes
 *  the outline tone. Exported for tests. */
export function cycleCountStatusTone(
  status: string,
): 'warning' | 'success' | 'destructive' | 'outline' {
  return status in TONE ? TONE[status as CycleCountStatusValue] : 'outline';
}

/**
 * A count's status label, shared by the history list and the count page so
 * the two can never word or colour a status differently. The words are the
 * core labels (In progress, Completed, Canceled); a status this build does not
 * know is printed as stored, in the outline tone, never hidden.
 *
 * The count chip has padding 0 8 and no border (DESIGN-SPEC 6.10), so it is
 * 18 px: the wash look drops the three tones' border and py-0 their 1 px of
 * vertical padding (FX10: the default chip look was 22 px). The outline tone
 * of an unknown status keeps its hairline, its only edge.
 */
export function CycleCountStatusBadge({ status }: { status: string }) {
  const words =
    status in TONE ? CYCLE_COUNT_STATUS_LABELS[status as CycleCountStatusValue] : status;
  return (
    <Badge variant={cycleCountStatusTone(status)} look="wash" className="py-0">
      {words}
    </Badge>
  );
}
