import { describeHoldTopUp, holdLeftShort, type HoldOutcome } from '@stockpilot/core';
import { toast } from 'sonner';

/**
 * What the automatic hold did after a line was added or raised (F2-2,
 * decision D15), in core's words (describeHoldTopUp, the phone's too).
 * Nothing is said when no hold was attempted (not a hold status, or the
 * editor may not approve orders) or when it held nothing and nothing is short.
 *
 * A failure is ALWAYS said, never swallowed (pattern #28): "Added. Stock was
 * not held for it; use Hold available stock.", with the reason underneath
 * (the service's sentence, e.g. no write access to the order's warehouse).
 * Units that could not be held for want of free stock are a warning too,
 * and so is an item the editor can't see that could not be fully held.
 */
export function announceHoldTopUp(outcome: HoldOutcome | null, change: 'added' | 'raised'): void {
  const sentence = describeHoldTopUp(outcome, change);
  if (!outcome || !sentence) return;
  if (!outcome.ok) {
    toast.warning(sentence, { description: outcome.message, duration: 10000 });
    return;
  }
  if (holdLeftShort(outcome)) {
    toast.warning(sentence, { duration: 8000 });
    return;
  }
  toast.success(sentence);
}
