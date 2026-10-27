'use client';

// Cart rail (sticky right column) + floating cart FAB for the
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

import {
  CART_CLEAR_ALL_COPY,
  CART_CLEAR_CONFIRM_COPY,
  CART_CLEAR_COPY,
  CART_EMPTY_BODY_COPY,
  CART_EMPTY_TITLE_COPY,
  CART_KEEP_COPY,
  CART_LINE_ITEMS_LABEL_COPY,
  CART_MANAGER_NOTES_LABEL_COPY,
  CART_MANAGER_NOTES_PLACEHOLDER_COPY,
  CART_NEEDED_BY_HINT_COPY,
  CART_NEEDED_BY_LABEL_COPY,
  CART_OPTIONAL_COPY,
  CART_REVIEW_BUTTON_COPY,
  CART_SUBMIT_FINE_PRINT_COPY,
  CART_SUGGESTIONS_LABEL_COPY,
  CART_TITLE_COPY,
  CART_TOTAL_UNITS_LABEL_COPY,
  cartLineView,
  formatWallClock,
  neededByZoneNote,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
} from '@stockpilot/core';

import { useCart } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

import { CharterTag, QtyField, SfPhoto } from './storefront-cards';
import { availableOf, cartTotals } from './storefront-logic';

/**
 * The needed-by floor, as the "YYYY-MM-DDTHH:mm" a datetime-local input
 * speaks: an hour from now on the ORGANIZATION's wall clock (phone ordering
 * PO-2). The field is read in the organization's zone (the server converts it
 * with core wallClockToInstant), so its floor is computed there too, not in
 * the browser's zone.
 */
function neededByFloor(orgTimezone: string): string {
  return formatWallClock(Date.now() + 60 * 60 * 1000, orgTimezone);
}

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
  onSetQty: (itemId: string, quantity: number) => void;
  onReview: () => void;
  /** `organizations.timezone`: the needed-by field's zone. */
  orgTimezone: string;
  /** itemId -> why the last send refused it (item_not_orderable), named
   *  under its line from this cart. */
  refusedItems?: ReadonlyMap<string, string>;
  /**
   * The lines that can't be ordered from here (core cartNotOrderableMarks):
   * gone from this catalog (hidden from Orders, archived, out of scope) or
   * refused by the last send. Such a line is kept and can be lowered or
   * removed, never raised (ordering visibility, design 6.5).
   */
  notOrderable?: ReadonlySet<string>;
}

const NO_REFUSED_ITEMS: ReadonlyMap<string, string> = new Map();
const NO_ITEMS: ReadonlySet<string> = new Set();

export function CartRail({
  itemMap,
  suggestions,
  context,
  onAdd,
  onDec,
  onSetQty,
  onReview,
  orgTimezone,
  refusedItems = NO_REFUSED_ITEMS,
  notOrderable = NO_ITEMS,
}: CartRailProps) {
  // `locked`: an order request sent from this cart is not settled; every
  // control waits (the provider also drops any change).
  const { state, dispatch, locked } = useCart();
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [pulse, setPulse] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);

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
        <span className="ttl">{CART_TITLE_COPY}</span>
        <span className={pulse ? 'cnt pulse' : 'cnt'} data-zero={unitCount === 0}>
          {unitCount}
        </span>
        {lineCount > 0 && !confirmClear && (
          <button
            type="button"
            className="clr"
            disabled={locked}
            onClick={() => setConfirmClear(true)}
          >
            {CART_CLEAR_ALL_COPY}
          </button>
        )}
      </div>
      {lineCount > 0 && confirmClear && (
        <div className="sf-cart-confirm" role="group" aria-label={CART_CLEAR_CONFIRM_COPY}>
          <span>{CART_CLEAR_CONFIRM_COPY}</span>
          <button
            type="button"
            className="clr"
            disabled={locked}
            onClick={() => {
              dispatch({ type: 'clear' });
              setConfirmClear(false);
            }}
          >
            {CART_CLEAR_COPY}
          </button>
          <button type="button" className="clr" onClick={() => setConfirmClear(false)}>
            {CART_KEEP_COPY}
          </button>
        </div>
      )}

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
            <h5>{CART_EMPTY_TITLE_COPY}</h5>
            <p>{CART_EMPTY_BODY_COPY}</p>
            {suggestions.length > 0 && (
              <div className="sf-sugg">
                <div className="sf-sugg-lbl">{CART_SUGGESTIONS_LABEL_COPY}</div>
                {suggestions.map((s) => (
                  <button key={s.itemId} type="button" disabled={locked} onClick={() => onAdd(s.itemId)}>
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
            // A refused line is marked even before the catalog drops it.
            const refusedReason = refusedItems.get(line.itemId);
            const unorderable = notOrderable.has(line.itemId) || refusedReason !== undefined;
            // Core's view, the phone's rule: the item's name (never its id),
            // and what the line says under it.
            const view = cartLineView(line, item, unorderable, refusedReason);
            const available = item ? availableOf(item) : Infinity;
            // A marked line can be lowered or removed, never raised: its
            // field tops out at what it holds now.
            const ceiling = unorderable
              ? Math.min(line.quantity, Number.isFinite(available) ? available : line.quantity)
              : Number.isFinite(available)
                ? available
                : line.quantity;
            const atMax = unorderable || line.quantity >= available;
            const note = view.note;
            return (
              <div className="sf-line" key={line.itemId}>
                <div className="th">
                  {item ? <SfPhoto item={item} /> : <div className="sf-ph" />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{view.title}</div>
                  <div className="sk2">{item?.sku ?? ''}</div>
                  {item && <CharterTag item={item} />}
                </div>
                <div className="rt">
                  <button
                    type="button"
                    className="rm"
                    title="Remove"
                    aria-label={`Remove ${item?.name ?? 'this item'} from cart`}
                    disabled={locked}
                    onClick={() => dispatch({ type: 'remove', itemId: line.itemId })}
                  >
                    <Trash2 size={12} />
                  </button>
                  <div className="sf-step mini">
                    <button
                      type="button"
                      onClick={() => onDec(line.itemId)}
                      disabled={locked}
                      aria-label="Decrease quantity"
                    >
                      <Minus size={11} />
                    </button>
                    <QtyField
                      itemId={line.itemId}
                      qty={line.quantity}
                      available={ceiling}
                      onSetQty={onSetQty}
                    />
                    <button
                      type="button"
                      onClick={() => onAdd(line.itemId)}
                      disabled={atMax || locked}
                      aria-label="Increase quantity"
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
                {note && (
                  <div
                    className="sf-line-warn"
                    data-refused={
                      note.kind === 'refused' || note.kind === 'not_orderable' ? '' : undefined
                    }
                  >
                    <AlertTriangle size={12} />
                    {note.kind === 'not_orderable'
                      ? STOREFRONT_LINE_NOT_ORDERABLE_COPY
                      : note.message}
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
          <span>{CART_MANAGER_NOTES_LABEL_COPY}</span>
          <span className="opt">{CART_OPTIONAL_COPY}</span>
          {!notesOpen && state.notes.trim() !== '' && <span className="dot-has" />}
          <span className="chev">
            <ChevronDown size={13} />
          </span>
        </button>
        {notesOpen && (
          <textarea
            placeholder={CART_MANAGER_NOTES_PLACEHOLDER_COPY}
            value={state.notes}
            disabled={locked}
            maxLength={2000}
            onChange={(e) => dispatch({ type: 'set-notes', value: e.target.value })}
          />
        )}
      </div>

      {/* Needed by — optional deadline; approval auto-creates a linked
          Schedule event + reminders (mig 0255). */}
      <div className="sf-needed-by">
        <label htmlFor="sf-needed-by-input">
          {CART_NEEDED_BY_LABEL_COPY} <span className="opt">{CART_OPTIONAL_COPY}</span>
        </label>
        <input
          id="sf-needed-by-input"
          type="datetime-local"
          value={state.neededBy}
          min={neededByFloor(orgTimezone)}
          disabled={locked}
          onChange={(e) => dispatch({ type: 'set-needed-by', value: e.target.value })}
        />
        <p className="hint">{neededByZoneNote(orgTimezone)}</p>
        {state.neededBy !== '' && <p className="hint">{CART_NEEDED_BY_HINT_COPY}</p>}
      </div>

      {/* Footer */}
      <div className="sf-cart-foot">
        <div className="sf-tot">
          <span>{CART_LINE_ITEMS_LABEL_COPY}</span>
          <span className="v">{lineCount}</span>
        </div>
        <div className="sf-tot">
          <span>{CART_TOTAL_UNITS_LABEL_COPY}</span>
          <span className="v">{unitCount}</span>
        </div>
        <button
          type="button"
          className="sf-submit"
          disabled={lineCount === 0}
          onClick={onReview}
        >
          {CART_REVIEW_BUTTON_COPY} <ChevronRight size={14} />
        </button>
        <div className="fine">{CART_SUBMIT_FINE_PRINT_COPY}</div>
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
