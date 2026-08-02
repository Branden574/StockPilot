'use client';

// Overlay pieces for the storefront order page: a small scoped popover
// primitive (setup bar + toolbar), the quick-view drawer, and the
// review → success modal.

import { Check, ClipboardList, Loader2, X } from 'lucide-react';
import * as React from 'react';

import type { CartLineState, CatalogItem, StorefrontCharter } from '../v2/types';

import { CharterTag, SfAddControl, SfPhoto } from './storefront-cards';
import DeliveryRequestAction from './delivery-request-action';
import {
  availableOf,
  cartTotals,
  successRefLine,
  statusOf,
} from './storefront-logic';

/* ---- popover primitive -------------------------------------------------- */

interface SfPopoverProps {
  open: boolean;
  onClose: () => void;
  /** Align to the right edge of the trigger container. */
  right?: boolean;
  /** Override min-width (defaults to 264px from the spec). */
  width?: number;
  children: React.ReactNode;
}

/**
 * Anchored popover matching the design's SFPop: rendered inside a
 * `position: relative` trigger container, entrance animation, closes
 * on Escape or any pointer-down outside the trigger container (so the
 * trigger's own toggle handler keeps working).
 */
export function SfPopover({ open, onClose, right, width, children }: SfPopoverProps) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const container = el?.parentElement ?? el;
      if (container && e.target instanceof Node && !container.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      className={right ? 'sf-pop right' : 'sf-pop'}
      style={width ? { minWidth: width } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/* ---- quick view drawer ---------------------------------------------------- */

interface QuickViewDrawerProps {
  item: CatalogItem | null;
  qty: number;
  onAdd: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onSetQty: (itemId: string, quantity: number) => void;
  onClose: () => void;
}

export function QuickViewDrawer({
  item,
  qty,
  onAdd,
  onDec,
  onSetQty,
  onClose,
}: QuickViewDrawerProps) {
  const open = item !== null;
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!item) return null;

  const available = availableOf(item);
  const status = statusOf(item);

  return (
    <>
      <div className="sf-drawer-backdrop" onClick={onClose} aria-hidden />
      <div
        className="sf-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Quick view: ${item.name}`}
      >
        <div className="sf-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sf-eyebrow">{item.categoryName ?? 'Uncategorized'}</div>
            <div className="sf-drawer-title">{item.name}</div>
          </div>
          <button
            type="button"
            className="sf-icon-btn"
            onClick={onClose}
            aria-label="Close quick view"
          >
            <X size={15} />
          </button>
        </div>
        <div className="sf-drawer-body">
          <div className="sf-qv-photo">
            <SfPhoto item={item} />
          </div>
          <div className="sf-spec">
            <div>
              <div className="k">SKU</div>
              <div className="v">{item.sku}</div>
            </div>
            <div>
              <div className="k">Bin location</div>
              <div className="v">{item.rackLabel ?? '—'}</div>
            </div>
            <div>
              <div className="k">Available</div>
              <div className="v">
                {available} {available === 1 ? 'unit' : 'units'}
              </div>
            </div>
            <div>
              <div className="k">Status</div>
              <div className="v">
                {status === 'out'
                  ? 'Out of stock'
                  : status === 'low'
                    ? 'Low stock'
                    : 'In stock'}
              </div>
            </div>
          </div>
          {item.charterName && (
            <p className="sf-qv-desc">
              Earmarked for {item.charterName}
              {item.charterCode ? ` (${item.charterCode})` : ''}.
            </p>
          )}
        </div>
        <div className="sf-drawer-foot">
          <SfAddControl
            item={item}
            qty={qty}
            onAdd={onAdd}
            onDec={onDec}
            onSetQty={onSetQty}
          />
        </div>
      </div>
    </>
  );
}

/* ---- review + success modal ------------------------------------------------ */

export interface ReviewSummary {
  warehouseName: string;
  method: 'pickup' | 'delivery';
  /** "DC4 will-call desk" or the delivery site (charter) name. */
  deliverTo: string;
  requestedFor: string;
  /** The requester's email — the one contact DC4 can reliably reach. */
  requesterEmail: string | null;
  /** `organizations.timezone`; the draft renders needed-by in it. */
  orgTimezone: string;
}

interface ReviewModalProps {
  stage: 'review' | 'success' | null;
  lines: readonly CartLineState[];
  itemMap: ReadonlyMap<string, CatalogItem>;
  notes: string;
  summary: ReviewSummary;
  /**
   * Raw `datetime-local` value from the cart ('YYYY-MM-DDTHH:mm') or ''. It has
   * never reached this modal before; the delivery-request draft needs it. It is
   * NOT an ISO instant — the builder normalises it the same way
   * handleConfirmSubmit does, with `new Date(v).toISOString()`.
   */
  neededBy: string;
  /**
   * The delivery site, when the order is a delivery. Null for pickup — and the
   * draft must then print no destination at all rather than an empty block.
   */
  destination: StorefrontCharter | null;
  submitting: boolean;
  /** Set once the order is created — drives the success reference line. */
  submitted: { id: string; orderNumber: number | null; unitCount: number } | null;
  onClose: () => void;
  onConfirm: () => void;
  onViewOrder: () => void;
  onDone: () => void;
}

export function ReviewModal({
  stage,
  lines,
  itemMap,
  notes,
  summary,
  neededBy,
  destination,
  submitting,
  submitted,
  onClose,
  onConfirm,
  onViewOrder,
  onDone,
}: ReviewModalProps) {
  const open = stage !== null;
  const closable = stage === 'review' && !submitting;

  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  /**
   * Focus management for a hand-rolled dialog.
   *
   * This modal has always declared role="dialog" aria-modal="true" while doing
   * neither of the two things that declaration promises: Tab walked straight
   * out into the page behind it, and closing dropped focus to <body>. That was
   * survivable when the success screen held two buttons; it is not now that it
   * holds a mail action, a preview, a copy control and a fallback textarea.
   *
   * Deliberately NOT a migration to Radix Dialog: this is a working surface
   * with its own visual language, and the one place that genuinely needed
   * Radix — the preview dialog — already uses it.
   *
   * Split into three effects (rather than one effect doing everything) because
   * they churn on different things:
   *
   *   1. Capture + restore — keyed on `open` ONLY. Fires exactly once per
   *      "open episode": captures whatever had focus right before opening,
   *      and its cleanup — which only runs when `open` flips back to false,
   *      or on unmount — restores it. Nothing else may cause this cleanup to
   *      run, or a benign parent re-render (see effect 3's rationale) would
   *      restore focus to the trigger mid-open, a real bug this used to have.
   *   2. Initial placement — keyed on `[open, stage]`. Places focus on the
   *      first focusable control (else the dialog itself) whenever the modal
   *      opens AND whenever `stage` changes while it stays open. That second
   *      case is what makes the review → success submit transition land
   *      focus on the success stage's own first control directly, with no
   *      detour through the external trigger.
   *   3. The keydown listener — keyed on `[open, closable, onClose]`, same as
   *      the old single effect. Rebinding this one on every dep churn is
   *      harmless: its cleanup ONLY removes the listener now, with no focus
   *      side effect. `focusables()` is still recomputed live from the DOM on
   *      every keydown, not memoized at mount, so it stays correct as
   *      controls appear/disappear.
   */

  const focusables = React.useCallback((): HTMLElement[] => {
    const root = dialogRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  // Effect 1: capture + restore. Deliberately NOT keyed on `stage` or
  // `closable` — a stage change or a submitting-state flip while the modal
  // stays open must not re-capture (there is nothing to restore FROM at that
  // point but the dialog's own last-focused control) and must not restore
  // (there has been no real close).
  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Runs only when `open` flips to false, or on unmount — a real close —
      // so a keyboard user is not dropped at the top of the document.
      restoreRef.current?.focus();
    };
  }, [open]);

  // Effect 2: initial placement, re-run on stage change while open.
  React.useEffect(() => {
    if (!open) return;
    const first = focusables()[0];
    if (first) first.focus();
    else dialogRef.current?.focus();
  }, [open, stage, focusables]);

  // Effect 3: the keydown listener only.
  React.useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closable) onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const active = document.activeElement;
      // Another dialog (the Radix preview, portalled to document.body) may
      // legitimately own focus. If the active element sits inside a dialog
      // that is not THIS one, its own trap governs — do nothing. `closest`
      // finds this modal for our own descendants because the container
      // carries role="dialog".
      if (active instanceof Element) {
        const owningDialog = active.closest('[role="dialog"]');
        if (owningDialog && owningDialog !== dialogRef.current) return;
      }

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;

      if (e.shiftKey && (active === firstItem || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closable, onClose, focusables]);

  if (!stage) return null;

  const { lineCount, unitCount } = cartTotals(lines);

  return (
    <div
      className="sf-modal-bk"
      onMouseDown={closable ? onClose : undefined}
    >
      <div
        className="sf-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={stage === 'review' ? 'Review order request' : 'Order request submitted'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {stage === 'review' ? (
          <>
            <div className="sf-modal-head">
              <ClipboardList size={16} />
              <div>
                <h3>Review order request</h3>
                <div className="sub">
                  Check the details — your manager sees exactly this.
                </div>
              </div>
              <button
                type="button"
                className="sf-icon-btn x"
                onClick={onClose}
                aria-label="Close review"
              >
                <X size={15} />
              </button>
            </div>
            <div className="sf-modal-body">
              <div className="sf-rev-grid">
                <div>
                  <div className="k">Warehouse</div>
                  <div className="v">{summary.warehouseName}</div>
                </div>
                <div>
                  <div className="k">Method</div>
                  <div className="v">
                    {summary.method === 'pickup' ? 'Pickup · will-call' : 'Delivery'}
                  </div>
                </div>
                <div>
                  <div className="k">Deliver to</div>
                  <div className="v">{summary.deliverTo}</div>
                </div>
                <div>
                  <div className="k">Requested for</div>
                  <div className="v">{summary.requestedFor}</div>
                </div>
              </div>
              <div>
                {lines.map((line) => {
                  const item = itemMap.get(line.itemId);
                  return (
                    <div className="sf-rev-line" key={line.itemId}>
                      <div className="th">
                        {item ? <SfPhoto item={item} /> : <div className="sf-ph" />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">{item?.name ?? line.itemId}</div>
                        <div className="sk2">{item?.sku ?? ''}</div>
                        {item && <CharterTag item={item} />}
                      </div>
                      <div className="q">× {line.quantity}</div>
                    </div>
                  );
                })}
              </div>
              {notes.trim() !== '' && (
                <div className="sf-rev-notes">
                  <div className="k">Manager notes</div>
                  {notes}
                </div>
              )}
            </div>
            <div className="sf-modal-foot">
              <span className="grow2">
                {lineCount} line {lineCount === 1 ? 'item' : 'items'} · {unitCount}{' '}
                {unitCount === 1 ? 'unit' : 'units'}
              </span>
              <button
                type="button"
                className="sf-btn-ghost"
                onClick={onClose}
                disabled={submitting}
              >
                Keep browsing
              </button>
              <button
                type="button"
                className="sf-btn-go"
                onClick={onConfirm}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Confirm &amp; submit
              </button>
            </div>
          </>
        ) : (
          <div className="sf-success">
            <div className="ok">
              <Check size={30} strokeWidth={2} />
            </div>
            <h3>Order request submitted</h3>
            <div className="ref">
              {submitted
                ? successRefLine(
                    submitted.orderNumber,
                    submitted.id,
                    summary.warehouseName,
                    submitted.unitCount,
                  )
                : ''}
            </div>
            <p>
              Your manager has been notified. You&apos;ll get an email when it&apos;s
              approved and stock is reserved for{' '}
              {summary.method === 'pickup' ? 'pickup' : 'delivery'}.
            </p>
            <div className="acts">
              {submitted && (
                <DeliveryRequestAction
                  input={{
                    orderId: submitted.id,
                    orderNumber: submitted.orderNumber,
                    fulfillmentType: summary.method,
                    warehouseName: summary.warehouseName,
                    destination,
                    requestedFor: summary.requestedFor,
                    requesterEmail: summary.requesterEmail,
                    neededByLocal: neededBy,
                    orgTimezone: summary.orgTimezone,
                    notes,
                    lines,
                    itemMap,
                  }}
                />
              )}
              <button type="button" className="sf-btn-ghost" onClick={onViewOrder}>
                View order
              </button>
              <button type="button" className="sf-btn-go" onClick={onDone}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
