import { describe, expect, it } from 'vitest';

import { FOCUS_SCROLL_INSET, focusScrollY, orderScreenFocus, shouldOpenSignatureOnArrival } from './order-focus';

describe('the order screen’s focus parameter (phone ordering PO-4)', () => {
  it('?focus=approve asks for the actions section; anything else for nothing', () => {
    expect(orderScreenFocus('approve')).toBe('actions');
    expect(orderScreenFocus(['approve'])).toBe('actions');
    expect(orderScreenFocus('actions')).toBe('actions');
    expect(orderScreenFocus(undefined)).toBeNull();
    expect(orderScreenFocus('cancel')).toBeNull();
    expect(orderScreenFocus(1)).toBeNull();
  });

  it('scrolls a little above the section, never before the top', () => {
    expect(focusScrollY(500)).toBe(500 - FOCUS_SCROLL_INSET);
    expect(focusScrollY(4)).toBe(0);
    expect(focusScrollY(Number.NaN)).toBeNull();
  });
});

// Returns RX-2 review (counter taps): the RMA's Hand over opens the
// replacement's order with ?focus=sign. The screen scrolls to its actions and
// opens the paper signature once, when the order has loaded, is ready to hand
// over and this viewer may confirm it (the screen offers Physical signature),
// online and with nothing else running; never again on a reload.
describe('?focus=sign: the paper signature on arrival (returns RX-2 counter taps)', () => {
  const ready = { focus: 'sign', opened: false, loaded: true, offered: true, online: true, busy: false };

  it('scrolls to the actions, as ?focus=approve does', () => {
    expect(orderScreenFocus('sign')).toBe('actions');
    expect(orderScreenFocus(['sign'])).toBe('actions');
  });

  it('opens once, only when ready and the viewer may confirm it', () => {
    expect(shouldOpenSignatureOnArrival(ready)).toBe(true);
    expect(shouldOpenSignatureOnArrival({ ...ready, focus: ['sign'] })).toBe(true);
    expect(shouldOpenSignatureOnArrival({ ...ready, opened: true })).toBe(false);
    expect(shouldOpenSignatureOnArrival({ ...ready, loaded: false })).toBe(false);
    // Not at a hand-over status, or a viewer who may not confirm: not offered.
    expect(shouldOpenSignatureOnArrival({ ...ready, offered: false })).toBe(false);
    expect(shouldOpenSignatureOnArrival({ ...ready, online: false })).toBe(false);
    expect(shouldOpenSignatureOnArrival({ ...ready, busy: true })).toBe(false);
    for (const focus of ['approve', 'actions', undefined, 'SIGN', 1]) {
      expect(shouldOpenSignatureOnArrival({ ...ready, focus }), String(focus)).toBe(false);
    }
  });
});
