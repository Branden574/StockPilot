'use client';

// Public request cart — the internal storefront's sf-cart rail skin
// (storefront-cart.tsx) on the anonymous /r/<token> flow. Submit still
// posts to POST /api/v1/public/order-requests and hands off to the
// double-opt-in "Check your inbox" panel via onSubmitted; only the
// presentation changed in P4.

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Minus,
  Package,
  PencilLine,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
  Warehouse,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { clearCartDraft, useCart } from '@/components/orders/v2/cart-context';

import { QtyField } from '../storefront/storefront-cards';
import { cartTotals } from '../storefront/storefront-logic';

import { PublicPhoto } from './public-item-card';
import { publicCapFinite, publicCapOf } from './public-logic';
import type { PublicCatalogItem } from './types';

export interface SubmittedState {
  id: string;
  email: string;
  trackUrl: string;
}

interface PublicCartRailProps {
  token: string;
  /** Raw warehouse id — goes into the submit payload. */
  warehouseId: string;
  /** localStorage draft key ("public:<warehouseId>") — cleared on success. */
  draftKey: string;
  warehouseName: string;
  /** Map of itemId → PublicCatalogItem for thumbnail + name lookups. */
  itemMap: ReadonlyMap<string, PublicCatalogItem>;
  /** Requester fields — owned by the root and passed down so this component
   *  can include them in the submit payload without duplicating state. */
  name: string;
  email: string;
  phone: string;
  pickupNotes: string;
  honeypot: string;
  onSubmitted: (state: SubmittedState) => void;
}

export function PublicCartRail({
  token,
  warehouseId,
  draftKey,
  warehouseName,
  itemMap,
  name,
  email,
  phone,
  pickupNotes,
  honeypot,
  onSubmitted,
}: PublicCartRailProps) {
  const { state, dispatch } = useCart();
  const [submitting, setSubmitting] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);

  const lines = state.lines;
  const { lineCount, unitCount } = cartTotals(lines);

  // Screen-reader live region for cart changes
  const [announcement, setAnnouncement] = React.useState('');
  const prevCount = React.useRef(unitCount);
  React.useEffect(() => {
    if (unitCount !== prevCount.current) {
      setAnnouncement(`${unitCount} item${unitCount === 1 ? '' : 's'} in cart.`);
      prevCount.current = unitCount;
    }
  }, [unitCount]);

  async function handleSubmit() {
    if (submitting) return;

    if (!name.trim() || !email.trim()) {
      toast.error('Add your name and email.');
      return;
    }
    if (lines.length === 0) {
      toast.error('Add at least one item.');
      return;
    }
    if (state.fulfillmentType === 'delivery' && !state.charterId) {
      toast.error('Pick a delivery site.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/order-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          warehouseId,
          requesterName: name.trim(),
          requesterEmail: email.trim(),
          notes: state.notes.trim() || undefined,
          lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
          fulfillmentType: state.fulfillmentType,
          requesterPhone: phone.trim() || null,
          deliveryCharterId:
            state.fulfillmentType === 'delivery' ? state.charterId : null,
          pickupLocationNotes:
            state.fulfillmentType === 'pickup' ? pickupNotes.trim() || null : null,
          hp: honeypot || undefined,
        }),
      });

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        toast.error(
          (json.message as string | undefined) ??
            (json.error as string | undefined) ??
            'Something went wrong.',
        );
        return;
      }

      const ok = json as { id: string; trackUrl: string };
      // Clear the persisted PUBLIC draft (key is prefixed "public:<wh>" to
      // avoid colliding with a staff draft on a shared browser).
      clearCartDraft(draftKey);
      dispatch({ type: 'clear' });
      onSubmitted({ id: ok.id, email: email.trim(), trackUrl: ok.trackUrl });
    } catch {
      toast.error("Couldn't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sf-cart" aria-label="Request cart">
      <div aria-live="polite" aria-atomic="true" className="sf-sr-only">
        {announcement}
      </div>

      {/* Header */}
      <div className="sf-cart-head">
        <ShoppingCart size={15} />
        <span className="ttl">Your Request</span>
        <span className="cnt" data-zero={unitCount === 0}>
          {unitCount}
        </span>
        {lineCount > 0 && (
          <button type="button" className="clr" onClick={() => dispatch({ type: 'clear' })}>
            Clear all
          </button>
        )}
      </div>

      {/* Context strip */}
      <div className="sf-cart-ctx">
        <span className="sf-ctx-chip">
          <span className="icon">
            <Warehouse size={11} />
          </span>
          {warehouseName}
        </span>
        <span className="sf-ctx-chip">
          <span className="icon">
            {state.fulfillmentType === 'pickup' ? <Package size={11} /> : <Truck size={11} />}
          </span>
          {state.fulfillmentType === 'pickup' ? 'Pickup' : 'Delivery'}
        </span>
        {name.trim() !== '' && (
          <span className="sf-ctx-chip">For {name.trim().split(/\s+/)[0]}</span>
        )}
      </div>

      {/* Line items / empty state */}
      <div className="sf-cart-list">
        {lineCount === 0 ? (
          <div className="sf-cart-empty">
            <div className="ring">
              <ShoppingCart size={26} />
            </div>
            <h5>Nothing here yet</h5>
            <p>
              Browse the catalog and add items —
              <br />
              they queue here until you send the request.
            </p>
          </div>
        ) : (
          lines.map((line) => {
            const item = itemMap.get(line.itemId);
            const cap = item ? publicCapOf(item) : Infinity;
            const atMax = line.quantity >= cap;
            const over = line.quantity > cap;
            const limitBound = item?.maxQty != null && cap === item.maxQty;
            return (
              <div className="sf-line" key={line.itemId}>
                <div className="th">
                  {item ? <PublicPhoto item={item} /> : <div className="sf-ph" />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{item?.displayName ?? 'Unavailable item'}</div>
                  {item?.categoryLabel ? <div className="sk2">{item.categoryLabel}</div> : null}
                </div>
                <div className="rt">
                  <button
                    type="button"
                    className="rm"
                    title="Remove"
                    aria-label={`Remove ${item?.displayName ?? 'item'} from cart`}
                    onClick={() => dispatch({ type: 'remove', itemId: line.itemId })}
                  >
                    <Trash2 size={12} />
                  </button>
                  <div className="sf-step mini">
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'dec', itemId: line.itemId })}
                      aria-label="Decrease quantity"
                    >
                      <Minus size={11} />
                    </button>
                    <QtyField
                      itemId={line.itemId}
                      qty={line.quantity}
                      available={item ? publicCapFinite(item) : line.quantity}
                      onSetQty={(itemId, quantity) =>
                        dispatch({ type: 'set-qty', itemId, quantity })
                      }
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!atMax) dispatch({ type: 'inc', itemId: line.itemId });
                      }}
                      disabled={atMax}
                      aria-label="Increase quantity"
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
                {item && (atMax || over) && Number.isFinite(cap) && (
                  <div className="sf-line-warn">
                    <AlertTriangle size={12} />
                    {over
                      ? limitBound
                        ? `Limit ${item.maxQty} per request — reduce quantity`
                        : `Only ${cap} available — reduce quantity`
                      : limitBound
                        ? `Limit ${item.maxQty} per request`
                        : `All ${cap} available are in your request`}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Notes (collapsible) */}
      <div className="sf-notes" data-open={notesOpen}>
        <button
          type="button"
          className="sf-notes-head"
          onClick={() => setNotesOpen((o) => !o)}
          aria-expanded={notesOpen}
        >
          <PencilLine size={13} />
          <span>Notes</span>
          <span className="opt">Optional</span>
          {!notesOpen && state.notes.trim() !== '' && <span className="dot-has" />}
          <span className="chev">
            <ChevronDown size={13} />
          </span>
        </button>
        {notesOpen && (
          <textarea
            placeholder="Anything the team should know — deadlines, event, room number…"
            value={state.notes}
            maxLength={2000}
            onChange={(e) => dispatch({ type: 'set-notes', value: e.target.value })}
          />
        )}
      </div>

      {/* Footer */}
      <div className="sf-cart-foot">
        <div className="sf-tot">
          <span>Line items</span>
          <span className="v">{lineCount}</span>
        </div>
        <div className="sf-tot">
          <span>Total units</span>
          <span className="v">{unitCount}</span>
        </div>
        <button
          type="button"
          className="sf-submit"
          disabled={submitting || lineCount === 0}
          onClick={() => void handleSubmit()}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          Send request <ChevronRight size={14} />
        </button>
        <div className="fine">
          We&apos;ll email you a confirmation link first — the request is only
          reviewed after you confirm.
        </div>
      </div>
    </div>
  );
}
