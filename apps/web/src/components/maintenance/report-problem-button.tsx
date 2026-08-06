import Link from 'next/link';

import { Button } from '@/components/ui/button';

/** Deep-link HINT only (Task 17 binding constraint 2) — the new-request page
 *  and, ultimately, MaintenanceRequestsService.create() re-derive and
 *  validate every id server-side (uuid shape + THIS org) before it is ever
 *  attached to a request. A tampered/foreign id degrades gracefully there;
 *  this component only ever builds the query string, it never trusts these
 *  values for anything beyond that. */
export interface ReportProblemPrefill {
  itemId?: string;
  orderRequestId?: string;
  rentalId?: string;
}

interface ReportProblemButtonProps {
  /** module_enabled('maintenance_requests') for the caller's org — the same
   *  RPC checkModuleAccess() wraps and the nav entry's own gate. An org
   *  where the module is off must never see a dead affordance. */
  moduleEnabled: boolean;
  /** can(ctx, 'maintenance_requests:submit') — the same registry permission
   *  the nav entry's requiresAnyOf checks. A viewer who cannot submit a
   *  request must not see an action they cannot use. */
  canSubmit: boolean;
  /** Only defined keys are ever added to the query string. */
  prefill: ReportProblemPrefill;
}

/** "Report a problem" launch point (master brief §8) — deep-links to the
 *  maintenance new-request form with the current record prefilled. Dropped
 *  directly into a host page's action row the same way DuplicateItemDialog /
 *  BarcodeDisplay / CreateReturnDialog are: a single self-contained
 *  component, no external wrapping required. Renders nothing — not even a
 *  disabled affordance — when the module is off or the viewer cannot
 *  submit, so there is no dead link in an org where the module never
 *  applies and no visible action a read-only viewer cannot use. */
export function ReportProblemButton({ moduleEnabled, canSubmit, prefill }: ReportProblemButtonProps) {
  if (!moduleEnabled || !canSubmit) return null;

  const params = new URLSearchParams();
  if (prefill.itemId) params.set('itemId', prefill.itemId);
  if (prefill.orderRequestId) params.set('orderRequestId', prefill.orderRequestId);
  if (prefill.rentalId) params.set('rentalId', prefill.rentalId);
  const qs = params.toString();
  const href = `/dashboard/maintenance/new${qs ? `?${qs}` : ''}`;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>Report a problem</Link>
    </Button>
  );
}
