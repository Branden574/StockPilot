import type { PoImportStatus } from '@stockpilot/core';

import { Badge, type BadgeProps } from '@/components/ui/badge';

/**
 * Each import status on one of the six status tones (DESIGN-SPEC 6.10), in
 * place of hand-picked palette colours: the mute states read as outline,
 * parsing as neutral, the two good outcomes as success, review as warning and
 * a failure as destructive. A status this build does not know reads as outline.
 */
const TONES: Record<PoImportStatus, NonNullable<BadgeProps['variant']>> = {
  uploaded: 'outline',
  parsing: 'secondary',
  parsed: 'success',
  needs_review: 'warning',
  approved: 'success',
  failed: 'destructive',
  duplicate: 'outline',
  canceled: 'outline',
};

/** The words are the status itself, underscores read as spaces ("needs review"). */
export function PoImportStatusBadge({ status }: { status: PoImportStatus }) {
  return <Badge variant={TONES[status] ?? 'outline'}>{status.replace(/_/g, ' ')}</Badge>;
}
