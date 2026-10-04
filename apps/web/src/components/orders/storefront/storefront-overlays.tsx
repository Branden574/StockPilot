'use client';

// Overlay pieces for the storefront order page: a small scoped popover
// primitive (setup bar + toolbar), the quick-view drawer, and the
// review → success modal.

import { AlertTriangle, Check, ClipboardList, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  brandDeliveryRecipients,
  CART_MANAGER_NOTES_LABEL_COPY,
  CART_NEEDED_BY_LABEL_COPY,
  deliveryRequestInputFromSubmission,
  neededByLabel,
  neededByZoneNote,
  ORDER_CHECK_AND_FINISH_COPY,
  ORDER_DONT_SEND_COPY,
  ORDER_REPLAY_COPY,
  ORDER_SEE_MY_ORDERS_COPY,
  ORDER_UNCONFIRMED_TITLE_COPY,
  orderAlreadyPlacedCopy,
  REVIEW_KEEP_BROWSING_COPY,
  REVIEW_SUBMIT_COPY,
  REVIEW_SUBTITLE_COPY,
  REVIEW_TITLE_COPY,
  STOREFRONT_DELIVER_TO_COPY,
  SUCCESS_DONE_COPY,
  SUCCESS_REVIEW_AND_APPROVE_COPY,
  SUCCESS_TITLE_COPY,
  SUCCESS_VIEW_ORDER_COPY,
  successSentForApprovalCopy,
  wallClockToInstant,
  type OrderSummary,
  type OrgEmailRoutingRecipientsDto,
} from '@stockpilot/core';

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
   * The cart's needed-by: the ORGANIZATION's wall clock ('YYYY-MM-DDTHH:mm')
   * or ''. The review prints it in the organization's zone. The success
   * screen's email uses the placed order's stored instant instead.
   */
  neededBy: string;
  /**
   * The delivery site, when the order is a delivery. Null for pickup — and the
   * draft must then print no destination at all rather than an empty block.
   */
  destination: StorefrontCharter | null;
  /**
   * The org's delivery-request email routing (per-org, migration 0337),
   * resolved server-side; null = no valid routing, so the success screen
   * renders NO email action. Fail closed by construction: with no
   * recipients there is nothing to compose against, and the compiled L4L
   * constants are reachable only through the server's own
   * code-before-migration fallback, never from here.
   */
  deliveryRecipients: OrgEmailRoutingRecipientsDto | null;
  /** A send or a withdraw is out: every button waits, and the dialog cannot
   *  be closed. */
  submitting: boolean;
  /**
   * The placed order (phone ordering PO-2): the place answer's summary, and
   * whether the key had already placed it (a replay) or "Don't send it"
   * found it placed. Drives the success screen and its email.
   */
  submitted: { order: OrderSummary; replay: boolean; viaWithdraw: boolean } | null;
  /** The viewer, for "Requested for" on a self-order's email. */
  viewerLabel?: string;
  viewerEmail?: string | null;
  /**
   * The submission key is not settled (sending, unconfirmed, withdrawing):
   * the review cannot be closed (the cart is locked until it settles).
   */
  unsettled?: boolean;
  /** The unconfirmed panel's sentence (core orderUnconfirmedCopy), or null.
   *  The panel and its buttons show while this is set (unconfirmed,
   *  withdrawing, or a resend that is out); during the first send the review
   *  keeps its own Submit button, waiting. */
  panelText?: string | null;
  /** "Check and finish" is shown (a body this build can send again); it
   *  waits, disabled, while a send or a withdraw is out. */
  canResend?: boolean;
  /** A refusal, said inline as an alert (core orderRefusalCopy), or null. */
  refusalText?: string | null;
  /** "It was not sent. Your cart is unlocked." after a withdraw, or null. */
  noticeText?: string | null;
  /** The success screen offers Review and approve. */
  canApproveOrders?: boolean;
  onCheckAndFinish?: () => void;
  onDontSend?: () => void;
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
  deliveryRecipients,
  submitting,
  submitted,
  viewerLabel,
  viewerEmail,
  unsettled = false,
  panelText = null,
  canResend = false,
  refusalText = null,
  noticeText = null,
  canApproveOrders = false,
  onCheckAndFinish,
  onDontSend,
  onClose,
  onConfirm,
  onViewOrder,
  onDone,
}: ReviewModalProps) {
  const open = stage !== null;
  // Never while a send or a withdraw is out, and never while the key is
  // unsettled: the cart is locked until it is.
  const closable = stage === 'review' && !submitting && !unsettled;

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
  const neededByAt = neededBy ? wallClockToInstant(neededBy, summary.orgTimezone) : null;
  const neededByText = neededByAt !== null ? neededByLabel(neededByAt, summary.orgTimezone) : null;
  // Branded only to build the input (the action re-brands and reports a
  // value the factory refuses, and then renders nothing).
  const branded = (() => {
    if (!deliveryRecipients) return null;
    try {
      return brandDeliveryRecipients(deliveryRecipients);
    } catch {
      return null;
    }
  })();
  const emailInput =
    submitted && branded
      ? (() => {
          const { recipients: _recipients, ...input } = deliveryRequestInputFromSubmission(
            submitted.order,
            {
              warehouseName: summary.warehouseName,
              destination,
              viewerLabel: viewerLabel ?? summary.requestedFor,
              viewerEmail: viewerEmail ?? summary.requesterEmail,
              orgTimezone: summary.orgTimezone,
              notes,
              lines,
              itemMap,
            },
            branded,
          );
          return input;
        })()
      : null;

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
        aria-label={stage === 'review' ? REVIEW_TITLE_COPY : SUCCESS_TITLE_COPY}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {stage === 'review' ? (
          <>
            <div className="sf-modal-head">
              <ClipboardList size={16} />
              <div>
                <h3>{REVIEW_TITLE_COPY}</h3>
                <div className="sub">{REVIEW_SUBTITLE_COPY}</div>
              </div>
              <button
                type="button"
                className="sf-icon-btn x"
                onClick={onClose}
                disabled={!closable}
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
                  <div className="k">{STOREFRONT_DELIVER_TO_COPY}</div>
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
              {neededByText && (
                <div className="sf-rev-notes">
                  <div className="k">{CART_NEEDED_BY_LABEL_COPY}</div>
                  {neededByText}
                  <div className="hint">{neededByZoneNote(summary.orgTimezone)}</div>
                </div>
              )}
              {notes.trim() !== '' && (
                <div className="sf-rev-notes">
                  <div className="k">{CART_MANAGER_NOTES_LABEL_COPY}</div>
                  {notes}
                </div>
              )}
              {refusalText && (
                <div className="sf-rev-alert" role="alert">
                  <AlertTriangle size={14} aria-hidden /> {refusalText}
                </div>
              )}
              {noticeText && (
                <div className="sf-rev-notice" role="status">
                  {noticeText}
                </div>
              )}
              {panelText && (
                <div className="sf-rev-unconfirmed" role="alert" aria-busy={submitting}>
                  <div className="k">{ORDER_UNCONFIRMED_TITLE_COPY}</div>
                  <p>{panelText}</p>
                </div>
              )}
            </div>
            <div className="sf-modal-foot">
              <span className="grow2">
                {lineCount} line {lineCount === 1 ? 'item' : 'items'} · {unitCount}{' '}
                {unitCount === 1 ? 'unit' : 'units'}
              </span>
              {panelText ? (
                <>
                  <Link className="sf-btn-ghost" href="/dashboard/orders">
                    {ORDER_SEE_MY_ORDERS_COPY}
                  </Link>
                  <button
                    type="button"
                    className="sf-btn-ghost"
                    onClick={onDontSend}
                    disabled={submitting}
                  >
                    {ORDER_DONT_SEND_COPY}
                  </button>
                  {canResend && (
                    <button
                      type="button"
                      className="sf-btn-go"
                      onClick={onCheckAndFinish}
                      disabled={submitting}
                    >
                      {submitting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                      {ORDER_CHECK_AND_FINISH_COPY}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="sf-btn-ghost"
                    onClick={onClose}
                    disabled={submitting}
                  >
                    {REVIEW_KEEP_BROWSING_COPY}
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
                    {REVIEW_SUBMIT_COPY}
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="sf-success">
            <div className="ok">
              <Check size={30} strokeWidth={2} />
            </div>
            <h3>{SUCCESS_TITLE_COPY}</h3>
            <div className="ref">
              {submitted
                ? successRefLine(
                    submitted.order.orderNumber,
                    submitted.order.id,
                    summary.warehouseName,
                    submitted.order.unitCount,
                  )
                : ''}
            </div>
            {submitted && (submitted.viaWithdraw || submitted.replay) && (
              <p role="status">
                {submitted.viaWithdraw ? orderAlreadyPlacedCopy(submitted.order) : ORDER_REPLAY_COPY}
              </p>
            )}
            <p>{submitted ? successSentForApprovalCopy(submitted.order.requestedFor) : ''}</p>
            <div className="acts">
              {/* The email action renders ONLY when the org has resolved
                  delivery routing — an unconfigured or invalid org gets the
                  success screen with no compose action at all (fallback
                  matrix state B/D). Its input is built from the PLACED order
                  (its method and its stored needed-by instant) by core, as the
                  phone builds it. */}
              {emailInput && deliveryRecipients && (
                <DeliveryRequestAction recipients={deliveryRecipients} input={emailInput} />
              )}
              {submitted && canApproveOrders && (
                <button type="button" className="sf-btn-ghost" onClick={onViewOrder}>
                  {SUCCESS_REVIEW_AND_APPROVE_COPY}
                </button>
              )}
              <button type="button" className="sf-btn-ghost" onClick={onViewOrder}>
                {SUCCESS_VIEW_ORDER_COPY}
              </button>
              <button type="button" className="sf-btn-go" onClick={onDone}>
                {SUCCESS_DONE_COPY}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
