// ═══ WHY THIS FILE PINS A TIMEZONE ═══
//
// The bug under test only exists AWAY from UTC: the "Needed by" picker built
// its `min` with toISOString() (UTC) while <input type="datetime-local"> reads
// min as LOCAL wall time. Under TZ=UTC the two agree and the bug is invisible,
// so the timezone must be forced here rather than inherited from whatever
// machine runs the suite (vitest.config.ts sets none). Node re-reads
// process.env.TZ at runtime (v16+); ESM hoists the imports above this line,
// but nothing here reads a clock at import time — every Date under test is
// built inside a test body, after this has run.
process.env.TZ = 'America/Los_Angeles';

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CartProvider, initialCartState } from '../v2/cart-context';

// The photo/charter/qty widgets pull next/image and catalog styling; none of
// that is what this file is about.
vi.mock('./storefront-cards', () => ({
  SfPhoto: () => <div data-testid="sf-photo" />,
  CharterTag: () => <div data-testid="sf-charter-tag" />,
  QtyField: () => <div data-testid="sf-qty-field" />,
}));

import { CartRail } from './storefront-cart';

function renderRail() {
  return render(
    <CartProvider
      initial={initialCartState({ warehouseId: 'wh-1', fulfillmentType: 'pickup' })}
    >
      <CartRail
        itemMap={new Map()}
        suggestions={[]}
        context={{
          warehouseName: 'DC4',
          method: 'pickup',
          siteName: null,
          requesterLabel: 'For you',
        }}
        onAdd={vi.fn()}
        onDec={vi.fn()}
        onSetQty={vi.fn()}
        onReview={vi.fn()}
      />
    </CartProvider>,
  );
}

describe('CartRail — Needed by picker floor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('floors the picker at now + 1 hour in LOCAL wall time, not UTC', () => {
    // 16:30 Pacific. now + 1h is 17:30 the SAME local day, but 00:30 the NEXT
    // day in UTC — the exact window where the old toISOString() min greyed out
    // every remaining hour of today in the native calendar.
    vi.setSystemTime(new Date('2026-09-05T23:30:00Z'));
    renderRail();

    expect(screen.getByLabelText(/needed by/i)).toHaveAttribute(
      'min',
      '2026-09-05T17:30',
    );
  });

  it('rolls the floor to the next local day only when now + 1 hour really crosses midnight', () => {
    // 23:45 Pacific → 00:45 local tomorrow. Same instant is 06:45Z, so a UTC
    // slice would have produced today's date here — the mirror-image error.
    vi.setSystemTime(new Date('2026-09-06T06:45:00Z'));
    renderRail();

    expect(screen.getByLabelText(/needed by/i)).toHaveAttribute(
      'min',
      '2026-09-06T00:45',
    );
  });

  it('zero-pads single-digit months, days, hours and minutes', () => {
    // 2026-01-02 08:05 Pacific → min 09:05 local. Catches a formatter that
    // concatenates raw getMonth()/getDate() numbers.
    vi.setSystemTime(new Date('2026-01-02T16:05:00Z'));
    renderRail();

    expect(screen.getByLabelText(/needed by/i)).toHaveAttribute(
      'min',
      '2026-01-02T09:05',
    );
  });
});
