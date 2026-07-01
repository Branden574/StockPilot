'use client';

// Presentational catalog pieces for the storefront order page:
// product card (grid), compact row (list), category section,
// frequently-ordered carousel, skeletons, and empty-results state.
//
// Cards are React.memo'd and receive their cart quantity as a scalar
// prop (the root builds a Map<itemId, qty>) so a cart change only
// re-renders the affected cards — media-audit item 4.

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Minus,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import * as React from 'react';

import type { CatalogItem } from '../v2/types';

import {
  availabilityLabel,
  availableOf,
  glyphFor,
  statusOf,
  type ItemStatus,
} from './storefront-logic';

export interface CardCallbacks {
  onAdd: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onQuickView: (itemId: string) => void;
}

/* ---- photo box ---------------------------------------------------- */

export function SfPhoto({ item }: { item: CatalogItem }) {
  if (item.imageUrl) {
    return (
      <div className="sf-ph">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageUrl} alt={item.name} loading="lazy" decoding="async" />
      </div>
    );
  }
  if (item.lqip) {
    // Blurred LQIP backdrop while the signed thumbnail URL resolves —
    // items WITH a photo never flash the stark glyph placeholder.
    return (
      <div className="sf-ph">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.lqip} alt="" aria-hidden className="lqip" />
      </div>
    );
  }
  return (
    <div className="sf-ph">
      <span className="glyph">{glyphFor(item.name)}</span>
    </div>
  );
}

/* ---- availability pill (over photo) -------------------------------- */

function SfAvailPill({ status, available }: { status: ItemStatus; available: number }) {
  return (
    <span className={status === 'ok' ? 'sf-avail' : `sf-avail ${status}`}>
      <span className="d" />
      {availabilityLabel(status, available)}
    </span>
  );
}

/* ---- add / stepper control ------------------------------------------ */

interface AddControlProps {
  item: CatalogItem;
  qty: number;
  onAdd: (itemId: string) => void;
  onDec: (itemId: string) => void;
}

export function SfAddControl({ item, qty, onAdd, onDec }: AddControlProps) {
  const available = availableOf(item);
  if (available <= 0 && qty === 0) {
    return (
      <button type="button" className="sf-add oos" disabled>
        Out of stock
      </button>
    );
  }
  if (qty === 0) {
    return (
      <button type="button" className="sf-add" onClick={() => onAdd(item.id)}>
        <Plus size={13} /> Add to cart
      </button>
    );
  }
  const atMax = qty >= available;
  return (
    <div className="sf-step">
      <button type="button" onClick={() => onDec(item.id)} aria-label="Decrease">
        <Minus size={13} />
      </button>
      <span className="q">
        {qty}
        <span className="in-lbl">IN CART</span>
      </span>
      <button
        type="button"
        onClick={() => onAdd(item.id)}
        disabled={atMax}
        title={atMax ? 'All available stock is in your cart' : 'Increase'}
        aria-label="Increase"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

/* ---- product card (grid) --------------------------------------------- */

interface ProductCardProps extends CardCallbacks {
  item: CatalogItem;
  qty: number;
}

export const ProductCard = React.memo(function ProductCard({
  item,
  qty,
  onAdd,
  onDec,
  onQuickView,
}: ProductCardProps) {
  const available = availableOf(item);
  const status = statusOf(item);
  const out = status === 'out';
  return (
    <div className="sf-card" data-in-cart={qty > 0} data-out={out}>
      <div className="sf-ph-box">
        <SfPhoto item={item} />
        <SfAvailPill status={status} available={available} />
        <button
          type="button"
          className="sf-qv"
          title="Quick view"
          aria-label={`Quick view ${item.name}`}
          onClick={() => onQuickView(item.id)}
        >
          <Eye size={14} />
        </button>
      </div>
      <div className="sf-card-bd">
        <div className="sf-card-nm">{item.name}</div>
        <div className="sf-card-meta">
          <span>{item.sku}</span>
          <span className="sep">·</span>
          <span className="cat">{item.categoryName ?? 'Uncategorized'}</span>
        </div>
        <div className="sf-card-ctl">
          <SfAddControl item={item} qty={qty} onAdd={onAdd} onDec={onDec} />
        </div>
      </div>
    </div>
  );
});

/* ---- compact row (list view) ------------------------------------------ */

interface CompactRowProps extends CardCallbacks {
  item: CatalogItem;
  qty: number;
}

export const CompactRow = React.memo(function CompactRow({
  item,
  qty,
  onAdd,
  onDec,
  onQuickView,
}: CompactRowProps) {
  const available = availableOf(item);
  const status = statusOf(item);
  return (
    <div className="sf-row" data-out={status === 'out'}>
      <button
        type="button"
        className="th"
        onClick={() => onQuickView(item.id)}
        title="Quick view"
        aria-label={`Quick view ${item.name}`}
      >
        <SfPhoto item={item} />
      </button>
      <div style={{ minWidth: 0 }}>
        <div className="nm">{item.name}</div>
        <div className="sk2">{item.sku}</div>
      </div>
      <div className="cat">{item.categoryName ?? 'Uncategorized'}</div>
      <div className={status === 'ok' ? 'avl' : `avl ${status}`}>
        <span className="d" />
        {status === 'out'
          ? 'Out of stock'
          : status === 'low'
            ? `Low · ${available}`
            : `${available} avail`}
      </div>
      <div>
        <SfAddControl item={item} qty={qty} onAdd={onAdd} onDec={onDec} />
      </div>
    </div>
  );
});

/* ---- category section (collapsible) ------------------------------------ */

interface CategorySectionProps {
  name: string;
  itemCount: number;
  open: boolean;
  onToggle: () => void;
  /** Total items in the category — "View all N →" shows when > shown. */
  shownCount: number;
  onViewAll: () => void;
  showKitButton: boolean;
  onAddKit: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

export function CategorySection({
  name,
  itemCount,
  open,
  onToggle,
  shownCount,
  onViewAll,
  showKitButton,
  onAddKit,
  icon,
  children,
}: CategorySectionProps) {
  return (
    <section className="sf-cat-sec" data-open={open}>
      <div className="sf-sec-head">
        <button
          type="button"
          className="fold"
          onClick={onToggle}
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={open}
        >
          <ChevronDown size={14} />
        </button>
        <h3>
          {icon} {name}
        </h3>
        <span className="ct">{itemCount}</span>
        <span className="spacer" />
        {showKitButton && (
          <button
            type="button"
            className="sf-kit-btn"
            onClick={onAddKit}
            title="Add one of each in-stock kit item"
          >
            <Plus size={12} /> Add full kit
          </button>
        )}
        {itemCount > shownCount && (
          <button type="button" className="see" onClick={onViewAll}>
            View all {itemCount} <ChevronRight size={12} />
          </button>
        )}
      </div>
      {open && children}
    </section>
  );
}

/* ---- frequently-ordered carousel ----------------------------------------- */

export interface FreqEntry {
  item: CatalogItem;
  /** Orders containing this item in the ranking window. */
  count: number;
}

interface FreqCarouselProps extends CardCallbacks {
  entries: FreqEntry[];
  qtyByItemId: ReadonlyMap<string, number>;
  loading: boolean;
}

export function FreqCarousel({
  entries,
  qtyByItemId,
  loading,
  onAdd,
  onDec,
  onQuickView,
}: FreqCarouselProps) {
  const trackRef = React.useRef<HTMLDivElement>(null);

  const nudge = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
  };

  if (!loading && entries.length === 0) return null;

  return (
    <section className="sf-feat" aria-label="Frequently ordered">
      <div className="sf-sec-head">
        <h3>
          <Sparkles size={15} /> Frequently ordered
        </h3>
        <span className="sub">Based on your last 30 days</span>
        <span className="spacer" />
        <div className="sf-arrows">
          <button type="button" onClick={() => nudge(-1)} aria-label="Scroll back">
            <ChevronLeft size={14} />
          </button>
          <button type="button" onClick={() => nudge(1)} aria-label="Scroll forward">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div className="sf-feat-track" ref={trackRef}>
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div className="sf-sk-card feat" key={i}>
                <div className="sf-sk ph" />
                <div className="bd">
                  <div className="sf-sk" style={{ height: 12, width: '85%' }} />
                  <div className="sf-sk" style={{ height: 12, width: '55%' }} />
                </div>
              </div>
            ))
          : entries.map(({ item, count }, i) => {
              const qty = qtyByItemId.get(item.id) ?? 0;
              const available = availableOf(item);
              const status = statusOf(item);
              return (
                <div className="sf-feat-card" key={item.id} data-in-cart={qty > 0}>
                  <div style={{ position: 'relative' }}>
                    <div className="sf-ph-box">
                      <SfPhoto item={item} />
                    </div>
                    <span className="sf-feat-rank">
                      #{i + 1} · {count}×/mo
                    </span>
                    <button
                      type="button"
                      className="sf-qv"
                      title="Quick view"
                      aria-label={`Quick view ${item.name}`}
                      onClick={() => onQuickView(item.id)}
                    >
                      <Eye size={13} />
                    </button>
                  </div>
                  <div className="bd">
                    <div className="nm">{item.name}</div>
                    <div className="ft">
                      <span className={status === 'ok' ? 'av' : `av ${status}`}>
                        <span className="d" />
                        {available} avail
                      </span>
                      {qty === 0 ? (
                        <button
                          type="button"
                          className="sf-add-mini"
                          onClick={() => onAdd(item.id)}
                          disabled={available <= 0}
                          aria-label={`Add ${item.name}`}
                        >
                          <Plus size={13} />
                        </button>
                      ) : (
                        <div className="sf-step mini">
                          <button
                            type="button"
                            onClick={() => onDec(item.id)}
                            aria-label="Decrease"
                          >
                            <Minus size={11} />
                          </button>
                          <span className="q">{qty}</span>
                          <button
                            type="button"
                            onClick={() => onAdd(item.id)}
                            disabled={qty >= available}
                            aria-label="Increase"
                          >
                            <Plus size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
      </div>
    </section>
  );
}

/* ---- skeleton card --------------------------------------------------------- */

export function SkeletonCard() {
  return (
    <div className="sf-sk-card">
      <div className="sf-sk ph" />
      <div className="bd">
        <div className="sf-sk" style={{ height: 13, width: '85%' }} />
        <div className="sf-sk" style={{ height: 13, width: '55%' }} />
        <div
          className="sf-sk"
          style={{ height: 30, width: '100%', marginTop: 6, borderRadius: 9 }}
        />
      </div>
    </div>
  );
}

/* ---- empty results ----------------------------------------------------------- */

export function EmptyResults({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <div className="sf-empty">
      <div className="big">
        <Search size={24} />
      </div>
      <h4>Nothing matches{query ? ` “${query}”` : ' those filters'}</h4>
      <p>Try a different name, SKU or category — or clear your filters.</p>
      <button type="button" className="sf-btn-ghost" onClick={onClear}>
        Clear search &amp; filters
      </button>
    </div>
  );
}
