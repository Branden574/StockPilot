import { describe, expect, it } from 'vitest';

import { stockAvailability } from './stock-availability';

describe('stockAvailability', () => {
  it('splits on hand into reserved and available', () => {
    const a = stockAvailability({ onHand: 100, reserved: 72 });
    expect(a).toMatchObject({ onHand: 100, reserved: 72, available: 28 });
    expect(a.overReserved).toBe(false);
    expect(a.shortfall).toBe(0);
  });

  it('nothing reserved means everything is available', () => {
    expect(stockAvailability({ onHand: 46, reserved: 0 }).available).toBe(46);
  });

  it('fully reserved reads as zero available, not as a problem', () => {
    const a = stockAvailability({ onHand: 40, reserved: 40 });
    expect(a.available).toBe(0);
    // Exactly promised out is normal. It must NOT raise the over-reserved flag,
    // or every fully-committed item would cry wolf.
    expect(a.overReserved).toBe(false);
  });

  it('OVER-RESERVED is reported, not silently clamped to "sold out"', () => {
    // The case the flag exists for: 12 units promised against 10 owned. A bare
    // max(0, …) shows "0 available", which looks identical to sold out — but
    // sold out is normal and this is a promise that cannot be kept.
    const a = stockAvailability({ onHand: 10, reserved: 12 });
    expect(a.available).toBe(0);
    expect(a.overReserved).toBe(true);
    expect(a.shortfall).toBe(2);
  });

  it('never returns a negative available', () => {
    expect(stockAvailability({ onHand: 0, reserved: 500 }).available).toBe(0);
  });

  it('does not cry over-reserved on an input it had to invent', () => {
    // Caught by this suite while writing it. Flooring NaN to 0 makes the number
    // safe to RENDER; it does not make it TRUE, and deriving "5 promised
    // against 0 owned" from a value we made up reports a broken promise nobody
    // can substantiate. `available` still clamps to 0 — only the alarm is
    // withheld — because a warning that fires on bad data gets scrolled past.
    const a = stockAvailability({ onHand: Number.NaN, reserved: 5 });
    expect(a.available).toBe(0);
    expect(a.overReserved).toBe(false);
    expect(a.shortfall).toBe(0);
  });

  it('still flags a REAL zero-stock over-reservation', () => {
    // The other side of the line above: a genuine 0 with promises against it is
    // exactly the condition the flag exists for, and must survive the change.
    const a = stockAvailability({ onHand: 0, reserved: 5 });
    expect(a.overReserved).toBe(true);
    expect(a.shortfall).toBe(5);
  });

  it('floors junk inputs instead of propagating them', () => {
    // quantity_on_hand is numeric(14,4) and reserved is a fold over rows; one
    // bad row should degrade a single item's display, never yield a negative
    // "available" that reads as a credit downstream.
    expect(stockAvailability({ onHand: -20, reserved: 0 }).onHand).toBe(0);
    expect(stockAvailability({ onHand: 5, reserved: Number.NaN }).reserved).toBe(0);
  });

  it('keeps fractional quantities intact', () => {
    // Bulk goods are stocked in partial units; rounding here would quietly
    // invent or destroy stock in the one place operators read the number.
    expect(stockAvailability({ onHand: 10.5, reserved: 0.25 }).available).toBe(10.25);
  });
});
