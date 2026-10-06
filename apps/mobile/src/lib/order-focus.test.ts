import { describe, expect, it } from 'vitest';

import {
  FOCUS_SCROLL_INSET,
  focusScrollY,
  initialSignArrival,
  orderScreenFocus,
  stepSignatureOnArrival,
} from './order-focus';

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
  // Re-pinned by returns RX-2 review fix (simulator fault 2026-10-06; claim
  // kept): the focus-blind shouldOpenSignatureOnArrival is retired for
  // stepSignatureOnArrival, which also needs the screen in front and the
  // person who tapped Hand over (below).
  const ready = { focus: 'sign', focused: true, loaded: true, offered: true, online: true, busy: false, userId: 'mgr' };
  const opens = (input: typeof ready | Record<string, unknown>) =>
    stepSignatureOnArrival(initialSignArrival('mgr'), { ...ready, ...input } as typeof ready).open;

  it('scrolls to the actions, as ?focus=approve does', () => {
    expect(orderScreenFocus('sign')).toBe('actions');
    expect(orderScreenFocus(['sign'])).toBe('actions');
  });

  it('opens once, only when ready and the viewer may confirm it', () => {
    expect(opens(ready)).toBe(true);
    expect(opens({ focus: ['sign'] })).toBe(true);
    expect(stepSignatureOnArrival(stepSignatureOnArrival(initialSignArrival('mgr'), ready).state, ready).open).toBe(false);
    expect(opens({ loaded: false })).toBe(false);
    // Not at a hand-over status, or a viewer who may not confirm: not offered.
    expect(opens({ offered: false })).toBe(false);
    expect(opens({ online: false })).toBe(false);
    expect(opens({ busy: true })).toBe(false);
    for (const focus of ['approve', 'actions', undefined, 'SIGN', 1]) {
      expect(opens({ focus }), String(focus)).toBe(false);
    }
  });
});

// Returns RX-2 review fix, simulator fault 2026-10-06 (sim-RX2/shots-fix
// iphone-FAULT-01..03): QA Staff tapped Hand over (no prompt: staff may not
// confirm), left through a deep link so the order screen stayed mounted under
// the Orders list, signed out; when QA Manager signed in, the hidden screen's
// arrival rule passed (offered now, never opened before) and the "Physical
// signature" prompt opened over Home, naming no order: Record would have
// handed over SO-000050. The request belongs to the person who tapped Hand
// over, on the screen they are looking at: it waits until that screen is in
// front with the order loaded (the arrival), opens only while it is still in
// front for the same person, and is spent for good once they leave it or
// someone else is signed in.
describe('?focus=sign belongs to the screen in front and to who tapped Hand over (simulator fault)', () => {
  const on = { focus: 'sign', focused: true, loaded: true, offered: true, online: true, busy: false, userId: 'mgr' };

  it('replays the fault: staff arrives (not offered), leaves the screen, a manager signs in: never opens', () => {
    let s = initialSignArrival('staff');
    let r = stepSignatureOnArrival(s, { ...on, userId: 'staff', offered: false });
    expect(r.open).toBe(false);
    s = r.state;
    // The Orders list deep-linked on top: the order screen is no longer in front.
    r = stepSignatureOnArrival(s, { ...on, userId: 'staff', offered: false, focused: false });
    expect(r.open).toBe(false);
    s = r.state;
    // Signed out, then QA Manager signed in: the hidden screen is now offered.
    r = stepSignatureOnArrival(s, { ...on, userId: null, offered: false, focused: false });
    s = r.state;
    r = stepSignatureOnArrival(s, { ...on, userId: 'mgr', focused: false });
    expect(r.open).toBe(false);
    s = r.state;
    // Even if the manager later comes back to that screen.
    expect(stepSignatureOnArrival(s, { ...on, userId: 'mgr' }).open).toBe(false);
  });

  it('never opens on a screen that is not in front, and never for someone other than who tapped Hand over', () => {
    expect(stepSignatureOnArrival(initialSignArrival('mgr'), { ...on, focused: false }).open).toBe(false);
    expect(stepSignatureOnArrival(initialSignArrival('staff'), { ...on, userId: 'mgr' }).open).toBe(false);
    expect(stepSignatureOnArrival(initialSignArrival(null), { ...on }).open).toBe(false);
  });

  it('opens once on arrival when everything holds, waiting while the order loads', () => {
    let s = initialSignArrival('mgr');
    let r = stepSignatureOnArrival(s, { ...on, loaded: false });
    expect(r.open).toBe(false);
    s = r.state;
    r = stepSignatureOnArrival(s, { ...on });
    expect(r.open).toBe(true);
    s = r.state;
    // A reload, a pull to refresh or a cancelled prompt never opens it again.
    expect(stepSignatureOnArrival(s, { ...on }).open).toBe(false);
  });

  it('offline on arrival: opens when the connection comes back only if the viewer is still on the screen', () => {
    let s = initialSignArrival('mgr');
    let r = stepSignatureOnArrival(s, { ...on, online: false });
    expect(r.open).toBe(false);
    s = r.state;
    expect(stepSignatureOnArrival(s, { ...on }).open).toBe(true);
    // Left the screen while offline (another screen on top), then online: spent.
    s = stepSignatureOnArrival(initialSignArrival('mgr'), { ...on, online: false }).state;
    s = stepSignatureOnArrival(s, { ...on, online: false, focused: false }).state;
    expect(stepSignatureOnArrival(s, { ...on, focused: false }).open).toBe(false);
    expect(stepSignatureOnArrival(s, { ...on }).open).toBe(false);
  });

  it('asks nothing without ?focus=sign', () => {
    for (const focus of ['approve', 'actions', undefined, 'SIGN', 1]) {
      expect(stepSignatureOnArrival(initialSignArrival('mgr'), { ...on, focus }).open, String(focus)).toBe(false);
    }
  });
});
