'use client';

// Order Cart rail (sticky right column) + floating cart FAB for the
// stacked <1280px layout. State lives in the shared v2 cart context;
// this file is purely the storefront skin.

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Minus,
  Package,
  PencilLine,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react';
import * as React from 'react';

import { useCart } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

import { SfPhoto } from './storefront-cards';
import { availableOf, cartTotals } from './storefront-logic';

export interface CartSuggestion {
  itemId: string;
  name: string;
}

export interface CartContextInfo {
  warehouseName: string;
  method: 'pickup' | 'delivery';
  /** Charter (site) name when method = delivery and one is chosen. */
  siteName: string | null;
  /** "For you" or "For Jane" when ordering on behalf of someone. */
  requesterLabel: string;
}

interface CartRailProps {
  itemMap: ReadonlyMap<string, CatalogItem>;
  suggestions: CartSuggestion[];
  context: CartContextInfo;
  onAdd: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onReview: () => void;
}

export function CartRail({
  itemMap,
  suggestions,
  context,
  onAdd,
  onDec,
  onReview,
}: CartRailProps) {
  const { state, dispatch } = useCart();
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [pulse, setPulse] = React.useState(false);

  const lines = state.lines;
  const { lineCount, unitCount } = cartTotals(lines);

  // Scale-pulse the unit badge whenever the count changes (skip mount).
  const firstUnits = React.useRef(true);
  React.useEffect(() => {
    if (firstUnits.current) {
      firstUnits.current = false;
      return;
    }
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 320);
    return () => clearTimeout(t);
  }, [unitCount]);

  // Screen-reader announcement on cart changes (v2 pattern).
  const [announcement, setAnnouncement] = React.useState('');
  const prevCount = React.useRef(unitCount);
  React.useEffect(() => {
    if (unitCount !== prevCount.current) {
      setAnnouncement(`${unitCount} item${unitCount === 1 ? '' : 's'} in cart.`);
      prevCount.current = unitCount;
    }
  }, [unitCount]);

  return (
    <div className="sf-cart" aria-label="Order cart">
      <div aria-live="polite" aria-atomic="true" className="sf-sr-only">
        {announcement}
      </div>

      {/* Header */}
      <div className="sf-cart-head">
        <ShoppingCart size={15} />
        <span className="ttl">Order Cart</span>
        <span className={pulse ? 'cnt pulse' : 'cnt'} data-zero={unitCount === 0}>
          {unitCount}
        </span>
        {lineCount > 0 && (
          <button
            type="button"
            className="clr"
            onClick={() => dispatch({ type: 'clear' })}
          >
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
          {context.warehouseName}
        </span>
        <span className="sf-ctx-chip">
          <span className="icon">
            {context.method === 'pickup' ? <Package size={11} /> : <Truck size={11} />}
          </span>
          {context.method === 'pickup'
            ? 'Pickup · will-call'
            : (context.siteName ?? 'Delivery')}
        </span>
        <span className="sf-ctx-chip">
          <span className="icon">
            <Users size={11} />
          </span>
          {context.requesterLabel}
        </span>
      </div>

      {/* Line items / empty state */}
      <div className="sf-cart-list">
        {lineCount === 0 ? (
          <div className="sf-cart-empty">
            <div className="ring">
              <ShoppingCart size={26} />
            </div>
            <h5>Your cart is empty</h5>
            <p>
              Browse the catalog and add items —
              <br />
              they queue here until you submit.
            </p>
            {suggestions.length > 0 && (
              <div className="sf-sugg">
                <div className="sf-sugg-lbl">Start with your usuals</div>
                {suggestions.map((s) => (
                  <button key={s.itemId} type="button" onClick={() => onAdd(s.itemId)}>
                    <span className="sugg-nm">{s.name}</span>
                    <span className="plus">
                      <Plus size={12} />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          lines.map((line) => {
            const item = itemMap.get(line.itemId);
            const available = item ? availableOf(item) : Infinity;
            const atMax = line.quantity >= available;
            const over = line.quantity > available;
            return (
              <div className="sf-line" key={line.itemId}>
                <div className="th">
                  {item ? <SfPhoto item={item} /> : <div className="sf-ph" />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{item?.name ?? line.itemId}</div>
                  <div className="sk2">{item?.sku ?? ''}</div>
                </div>
                <div className="rt">
                  <button
                    type="button"
                    className="rm"
                    title="Remove"
                    aria-label={`Remove ${item?.name ?? 'item'} from cart`}
                    onClick={() => dispatch({ type: 'remove', itemId: line.itemId })}
                  >
                    <Trash2 size={12} />
                  </button>
                  <div className="sf-step mini">
                    <button
                      type="button"
                      onClick={() => onDec(line.itemId)}
                      aria-label="Decrease quantity"
                    >
                      <Minus size={11} />
                    </button>
                    <span className="q">{line.quantity}</span>
                    <button
                      type="button"
                      onClick={() => onAdd(line.itemId)}
                      disabled={atMax}
                      aria-label="Increase quantity"
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
                {item && (atMax || over) && (
                  <div className="sf-line-warn">
                    <AlertTriangle size={12} />
                    {over
                      ? `Only ${available} in stock — reduce quantity`
                      : `All ${available} available are in your cart`}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Manager notes (collapsible) */}
      <div className="sf-notes" data-open={notesOpen}>
        <button
          type="button"
          className="sf-notes-head"
          onClick={() => setNotesOpen((o) => !o)}
          aria-expanded={notesOpen}
        >
          <PencilLine size={13} />
          <span>Manager notes</span>
          <span className="opt">Optional</span>
          {!notesOpen && state.notes.trim() !== '' && <span className="dot-has" />}
          <span className="chev">
            <ChevronDown size={13} />
          </span>
        </button>
        {notesOpen && (
          <textarea
            placeholder="Anything the approving manager should know — deadlines, event, room number…"
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
          disabled={lineCount === 0}
          onClick={onReview}
        >
          Submit Order Request <ChevronRight size={14} />
        </button>
        <div className="fine">
          A manager will review and approve before stock is reserved.
        </div>
      </div>
    </div>
  );
}

/* ---- floating cart FAB (stacked layout, <1280px) ---------------------- */

export function CartFab({
  unitCount,
  onClick,
}: {
  unitCount: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sf-fab"
      data-show={unitCount > 0}
      onClick={onClick}
      aria-label={`Scroll to cart, ${unitCount} units`}
    >
      <ShoppingCart size={15} /> Cart · {unitCount}
    </button>
  );
}
