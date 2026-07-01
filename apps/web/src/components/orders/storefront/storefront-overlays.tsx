'use client';

// Overlay pieces for the storefront order page: a small scoped popover
// primitive (setup bar + toolbar), the quick-view drawer, and the
// review → success modal.

import { Check, ClipboardList, Loader2, X } from 'lucide-react';
import * as React from 'react';

import type { CartLineState, CatalogItem } from '../v2/types';

import { SfAddControl, SfPhoto } from './storefront-cards';
import {
  availableOf,
  cartTotals,
  orderRef,
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
}

interface ReviewModalProps {
  stage: 'review' | 'success' | null;
  lines: readonly CartLineState[];
  itemMap: ReadonlyMap<string, CatalogItem>;
  notes: string;
  summary: ReviewSummary;
  submitting: boolean;
  /** Set once the order is created — drives the success reference line. */
  submitted: { id: string; unitCount: number } | null;
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
  submitting,
  submitted,
  onClose,
  onConfirm,
  onViewOrder,
  onDone,
}: ReviewModalProps) {
  const open = stage !== null;
  const closable = stage === 'review' && !submitting;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closable) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closable, onClose]);

  if (!stage) return null;

  const { lineCount, unitCount } = cartTotals(lines);

  return (
    <div
      className="sf-modal-bk"
      onMouseDown={closable ? onClose : undefined}
    >
      <div
        className="sf-modal"
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
                ? orderRef(submitted.id, summary.warehouseName, submitted.unitCount)
                : ''}
            </div>
            <p>
              Your manager has been notified. You&apos;ll get an email when it&apos;s
              approved and stock is reserved for{' '}
              {summary.method === 'pickup' ? 'pickup' : 'delivery'}.
            </p>
            <div className="acts">
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
