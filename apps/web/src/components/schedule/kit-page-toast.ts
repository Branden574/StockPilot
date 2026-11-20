import { isUuid } from '@stockpilot/core';

/**
 * The link a Schedule save's error toast carries to the kit's page. When a
 * completion is saved but its kit was not handed out, ScheduleService.update
 * answers a sentence that ends "Hand it out from the kit's page." and names the
 * kit in `details.kitId`, only for a member that page offers Distribute to.
 * Then the toast gets an "Open kit" action; for any other answer, none.
 */
export function kitPageToastOptions(
  details: Record<string, unknown> | undefined,
  open: (href: string) => void,
): { action: { label: string; onClick: () => void } } | null {
  const kitId = details?.kitId;
  if (typeof kitId !== 'string' || !isUuid(kitId)) return null;
  return {
    action: { label: 'Open kit', onClick: () => open(`/dashboard/bundles/${kitId}`) },
  };
}
