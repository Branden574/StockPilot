import { ORDER_WITHDRAWN_COPY, orderRefusalCopy } from '@stockpilot/core';

import type { StorefrontSnapshot } from './session';

/**
 * THE ONE SENTENCE ABOUT HOW A SEND ENDED (phone ordering PO-4, desk check
 * F3), for every storefront screen: checkout, the home and a browse view, and
 * the screen shown with the storefront turned off or refused. A send can end
 * away from checkout (Don't send it from the unconfirmed panel on home, a
 * status read on open or on focus, the kill switch's panel), so each of them
 * says it, in core's words, and announces it:
 *
 *   - a final refusal: orderRefusalCopy (the cart's own item names);
 *   - withdrawn: "It was not sent. Your cart is unlocked.";
 *   - the device could not save the send (so nothing was sent);
 *   - a change the session refused (the lock, the warehouse switch, a kit).
 *
 * Placed says nothing here: the success screen says it. Pure.
 */

export interface StorefrontOutcome {
  text: string;
  /** Withdrawn reads calm; everything else is a refusal. */
  tone: 'critical' | 'calm';
}

export function storefrontOutcome(
  snap: Pick<StorefrontSnapshot, 'submission' | 'refusal'>,
  ctx: { itemName: (itemId: string) => string | null; warehouseName: string | null },
): StorefrontOutcome | null {
  const state = snap.submission.state;
  if (state.phase === 'refused') {
    return {
      text: orderRefusalCopy(state.reason, state.details, {
        surface: 'phone',
        itemName: ctx.itemName,
        warehouseName: ctx.warehouseName,
      }),
      tone: 'critical',
    };
  }
  if (state.phase === 'withdrawn') return { text: ORDER_WITHDRAWN_COPY, tone: 'calm' };
  const other = snap.submission.deviceError ?? snap.refusal;
  return other ? { text: other, tone: 'critical' } : null;
}
