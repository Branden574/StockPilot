import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// SfPhoto / CharterTag pull next/image and the catalog card styling, neither of
// which this file is about.
vi.mock('./storefront-cards', () => ({
  SfPhoto: () => <div data-testid="sf-photo" />,
  CharterTag: () => <div data-testid="sf-charter-tag" />,
  SfAddControl: () => <div data-testid="sf-add-control" />,
}));

import { ReviewModal } from './storefront-overlays';

import { DELIVERY_REQUEST_RECIPIENTS } from '@/lib/site';

// The routing DTO the server resolves for an org whose stored routing is
// the compiled pair (L4L's seed) — keeps every pin below byte-identical to
// pre-feature behavior. The hidden state (deliveryRecipients: null) gets
// its own test at the end of this file.
const TEST_ROUTING = {
  to: DELIVERY_REQUEST_RECIPIENTS.to,
  cc: DELIVERY_REQUEST_RECIPIENTS.cc,
  toName: DELIVERY_REQUEST_RECIPIENTS.toName,
  ccName: DELIVERY_REQUEST_RECIPIENTS.ccName,
};

const ITEM: CatalogItem = {
  id: 'i-1',
  sku: 'APP-POLO-W',
  name: "L4L Polo (Women's)",
  warehouseId: 'wh-1',
  quantityOnHand: 10,
  reservedQuantity: 0,
  itemType: null,
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  imageUrl: null,
  lqip: null,
  price: null,
  reorderPoint: 0,
};

function renderSuccess(overrides: Record<string, unknown> = {}) {
  const props = {
    stage: 'success' as const,
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([['i-1', ITEM]]),
    notes: 'Please stage these by Friday.',
    summary: {
      warehouseName: 'DC4',
      method: 'delivery' as const,
      deliverTo: 'CVW Clovis',
      requestedFor: 'Branden Vincent-Walker',
      requesterEmail: 'branden@cvwest.org',
      orgTimezone: 'America/Los_Angeles',
    },
    neededBy: '2026-08-05T09:00',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: { line1: '1295 Shaw Ave', city: 'Fresno', region: 'California', postalCode: '93612' },
    },
    deliveryRecipients: TEST_ROUTING,
    submitting: false,
    submitted: { id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 },
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onViewOrder: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ReviewModal {...props} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ReviewModal success stage', () => {
  it('prints the CANONICAL order number, never a uuid-derived SO- handle', () => {
    renderSuccess();
    expect(screen.getByText('SO-000049 · DC4 · 5 units')).toBeInTheDocument();
  });

  it('renders the delivery-request action alongside View order and Done', () => {
    renderSuccess();
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View order/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
  });

  it('renders the action for a PICKUP order too (owner decision D1) — with the PICKUP button copy', () => {
    renderSuccess({
      summary: {
        warehouseName: 'DC4',
        method: 'pickup',
        deliverTo: 'DC4 will-call desk',
        requestedFor: 'Branden Vincent-Walker',
        requesterEmail: 'branden@cvwest.org',
        orgTimezone: 'America/Los_Angeles',
      },
      destination: null,
    });
    // The composed mail's subject is 'Pickup Request — ...' for this order, so
    // the action's own copy follows the fulfillment type end to end.
    expect(screen.getByRole('button', { name: /Email pickup request/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Email delivery request/i })).toBeNull();
  });

  it('never claims a ticket was created anywhere on the success screen', () => {
    const { container } = renderSuccess();
    const text = (container.textContent ?? '').toLowerCase();
    for (const claim of ['ticket created', 'ticket submitted', 'assigned to', 'email sent']) {
      expect(text).not.toContain(claim);
    }
  });

  it('the existing actions still work — R1', async () => {
    const user = userEvent.setup();
    const { props } = renderSuccess();

    await user.click(screen.getByRole('button', { name: /View order/i }));
    expect(props.onViewOrder).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all when stage is null', () => {
    const { container } = render(
      <ReviewModal
        stage={null}
        lines={[]}
        itemMap={new Map()}
        notes=""
        summary={{
          warehouseName: 'DC4',
          method: 'delivery',
          deliverTo: 'CVW Clovis',
          requestedFor: 'X',
          requesterEmail: null,
          orgTimezone: 'America/Los_Angeles',
        }}
        neededBy=""
        destination={null}
        deliveryRecipients={TEST_ROUTING}
        submitting={false}
        submitted={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onViewOrder={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ReviewModal accessibility', () => {
  it('moves focus INTO the dialog when it opens', async () => {
    renderSuccess();
    const dialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('traps Tab inside the dialog — the last control wraps to the first', async () => {
    const user = userEvent.setup();
    renderSuccess();
    const dialog = screen.getByRole('dialog');

    // Walk forward well past the number of controls; focus must never escape.
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('traps Shift+Tab too — the first control wraps to the last', async () => {
    const user = userEvent.setup();
    renderSuccess();
    const dialog = screen.getByRole('dialog');

    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('RESTORES focus to the element that was focused before it opened', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Review';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Typed as the component's own prop type (rather than the brief's
    // `as never` spread cast) so `stage: 'success'` is contextually typed as
    // the literal, not widened to `string` — `tsc` rejects spreading a
    // `never`-cast object (TS2698: "Spread types may only be created from
    // object types"). Behavior is identical either way.
    const props: React.ComponentProps<typeof ReviewModal> = {
      stage: 'success',
      lines: [{ itemId: 'i-1', quantity: 5 }],
      itemMap: new Map([['i-1', ITEM]]),
      notes: '',
      summary: {
        warehouseName: 'DC4',
        method: 'delivery',
        deliverTo: 'CVW Clovis',
        requestedFor: 'Branden Vincent-Walker',
        requesterEmail: 'branden@cvwest.org',
        orgTimezone: 'America/Los_Angeles',
      },
      neededBy: '',
      destination: null,
      deliveryRecipients: TEST_ROUTING,
      submitting: false,
      submitted: { id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 },
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      onViewOrder: vi.fn(),
      onDone: vi.fn(),
    };
    const { unmount } = render(<ReviewModal {...props} />);

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    trigger.remove();
  });

  // Finding 2 (Important, plan-mandated): the call site's `onClose` is an
  // unstable inline arrow (`onClose={() => setReviewStage(null)}` in
  // orders-storefront.tsx), so it is a NEW function on every parent render.
  // A single effect keyed on `[open, closable, onClose]` tears down and
  // re-runs on every one of those renders while the modal is open — and its
  // cleanup unconditionally calls `restoreRef.current?.focus()`, which used
  // to fire on every dep churn, not only on a real close. A spy on the
  // pre-open trigger's own `focus` method catches this even though the
  // effect's own re-run immediately re-focuses a dialog control afterward
  // (in the same synchronous act flush) — a plain end-state
  // `document.activeElement` check would miss the transient call entirely.
  it('Finding 2: a rerender with a brand-new onClose reference does not restore focus to the pre-open trigger', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, 'focus');

    const { props, rerender } = renderSuccess();
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    // Mirrors the real call site: same stage, same everything else, just a
    // fresh onClose closure — exactly what happens on an unrelated parent
    // re-render while the modal sits open.
    rerender(<ReviewModal {...(props as React.ComponentProps<typeof ReviewModal>)} onClose={() => {}} />);

    expect(focusSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    trigger.remove();
  });

  it('Finding 2: the review-to-success stage transition focuses a success control, never the external trigger', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, 'focus');

    const baseProps: React.ComponentProps<typeof ReviewModal> = {
      stage: 'review',
      lines: [{ itemId: 'i-1', quantity: 5 }],
      itemMap: new Map([['i-1', ITEM]]),
      notes: '',
      summary: {
        warehouseName: 'DC4',
        method: 'delivery',
        deliverTo: 'CVW Clovis',
        requestedFor: 'Branden Vincent-Walker',
        requesterEmail: 'branden@cvwest.org',
        orgTimezone: 'America/Los_Angeles',
      },
      neededBy: '',
      destination: null,
      deliveryRecipients: TEST_ROUTING,
      submitting: false,
      submitted: null,
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      onViewOrder: vi.fn(),
      onDone: vi.fn(),
    };

    const { rerender } = render(<ReviewModal {...baseProps} />);
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    // The submit transition: stage flips straight from 'review' to 'success'
    // with `submitted` now set — accompanied by a fresh onClose reference,
    // exactly as the real call site produces on every render.
    rerender(
      <ReviewModal
        {...baseProps}
        stage="success"
        submitted={{ id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 }}
        onClose={() => {}}
      />,
    );

    expect(focusSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByText('Order request submitted')).toBeInTheDocument();

    trigger.remove();
  });

  it('every new control is reachable by keyboard and has an accessible name', async () => {
    const user = userEvent.setup();
    renderSuccess();

    const names = ['Email delivery request', 'Preview', 'View order', 'Done'];
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      const label = document.activeElement?.textContent?.trim() ?? '';
      for (const n of names) if (label.includes(n)) seen.add(n);
    }
    expect(Array.from(seen).sort()).toEqual([...names].sort());
  });

  // Finding 1 (CRITICAL, focus-trap fix wave): the Task 7 preview dialog is a
  // real Radix Dialog, portalled to document.body. It is NOT a descendant of
  // dialogRef.current (the ReviewModal's own `.sf-modal`), so the document-level
  // trap's escaped-focus recovery — "if activeElement isn't inside MY dialog,
  // yank it back" — used to fire on every Tab pressed inside the preview too.
  //
  // Under happy-dom, Radix's own FocusScope fights this back synchronously
  // (its `focusout` listener snaps focus straight back into its container the
  // instant our handler yanks it out), so `document.activeElement` never
  // visibly lands on a ReviewModal control across the cycle below — asserting
  // that alone would pass even with the bug present (confirmed empirically:
  // it passed before the fix, with `document.activeElement` pinned to the
  // textarea on every single Tab). The real, reproducible symptom is the one
  // Radix's counter-correction can't hide: Tab becomes a no-op stuck on
  // whichever control has focus, so it NEVER reaches the preview's other own
  // controls. That is what this test pins.
  it('does not hijack Tab when focus is legitimately inside the Task 7 preview dialog', async () => {
    const user = userEvent.setup();
    renderSuccess();

    await user.click(screen.getByRole('button', { name: /Preview/i }));
    const dialogs = await screen.findAllByRole('dialog');
    const preview = dialogs.find((d) => d.textContent?.includes('Delivery request preview'));
    expect(preview).not.toBeUndefined();
    const reviewModal = dialogs.find((d) => d !== preview);
    expect(reviewModal).not.toBeUndefined();

    const copyBtn = within(preview!).getByRole('button', { name: /Copy the details/i });
    const openBtn = within(preview!).getByRole('button', { name: /Open in Outlook/i });
    const textarea = within(preview!).getByLabelText(/Delivery request message preview/i);

    const reached = { copy: false, open: false, textarea: false };
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      const active = document.activeElement;
      // The ReviewModal's own controls must never receive focus while the
      // preview owns it.
      expect(reviewModal!.contains(active)).toBe(false);
      if (active === copyBtn) reached.copy = true;
      if (active === openBtn) reached.open = true;
      if (active === textarea) reached.textarea = true;
    }

    expect(reached).toEqual({ copy: true, open: true, textarea: true });
  });
});

/**
 * Per-org email routing (migration 0337), fallback matrix state B/D on the
 * storefront success overlay: an org with no resolved delivery routing gets
 * the SAME success screen minus the email action — nothing else about the
 * overlay changes, and no compiled recipient address appears anywhere.
 */
describe('success overlay without delivery routing', () => {
  it('renders no email action and no recipient address when deliveryRecipients is null', () => {
    const { container } = renderSuccess({ deliveryRecipients: null });
    expect(screen.queryByRole('button', { name: /Email delivery request/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preview/i })).toBeNull();
    // The rest of the success screen is unchanged.
    expect(screen.getByRole('button', { name: /View order/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
    expect(container.textContent).not.toContain('learn4life');
    expect(container.textContent).not.toContain('cvwest');
  });

  it('still renders the email action when routing resolved (control)', () => {
    renderSuccess();
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
  });
});
