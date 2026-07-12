'use client';

// Public catalog card — the sf-card visual from the internal storefront
// (owner request: the public page must look like /dashboard/orders/new),
// rendered from the narrow PublicCatalogItem schema. No SKU, price,
// charter, or location ever appears here because the type doesn't carry
// them.

import { Minus, Plus } from 'lucide-react';
import * as React from 'react';

import { QtyField } from '../storefront/storefront-cards';
import { glyphFor } from '../storefront/storefront-logic';

import {
  isUnavailable,
  publicAvailabilityLabel,
  publicCapFinite,
  publicStatusOf,
} from './public-logic';
import type { PublicCatalogItem } from './types';

/** Photo box: signed thumbnail → LQIP blur → serif letter glyph. */
export function PublicPhoto({ item, priority }: { item: PublicCatalogItem; priority?: boolean }) {
  if (item.imageUrl) {
    return (
      <div className="sf-ph">
        {/* Above-the-fold cards (priority) load eagerly at high fetch
            priority for a fast LCP; the rest stay lazy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.imageUrl}
          alt={item.displayName}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
        />
      </div>
    );
  }
  if (item.lqip) {
    return (
      <div className="sf-ph">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.lqip} alt="" aria-hidden className="lqip" />
      </div>
    );
  }
  return (
    <div className="sf-ph">
      <span className="glyph">{glyphFor(item.displayName)}</span>
    </div>
  );
}

export interface PublicCardCallbacks {
  onAdd: (itemId: string) => void;
  onDec: (itemId: string) => void;
  /** Set an exact quantity (typed into a stepper); ≤0 removes the line. */
  onSetQty: (itemId: string, quantity: number) => void;
}

interface PublicItemCardProps extends PublicCardCallbacks {
  item: PublicCatalogItem;
  qty: number;
  /** Above-the-fold card — its photo loads eagerly at high priority. */
  priority?: boolean;
}

export const PublicItemCard = React.memo(function PublicItemCard({
  item,
  qty,
  onAdd,
  onDec,
  onSetQty,
  priority,
}: PublicItemCardProps) {
  const status = publicStatusOf(item.availability);
  const label = publicAvailabilityLabel(item.availability);
  const out = isUnavailable(item);
  const cap = publicCapFinite(item);
  const atMax = qty >= cap;

  return (
    <div className="sf-card" data-in-cart={qty > 0} data-out={out}>
      <div className="sf-ph-box">
        <PublicPhoto item={item} priority={priority} />
        {/* availability_display='none' ships no stock signal at all */}
        {label !== null && (
          <span className={status === 'ok' || status === null ? 'sf-avail' : `sf-avail ${status}`}>
            <span className="d" />
            {label}
          </span>
        )}
      </div>
      <div className="sf-card-bd">
        <div className="sf-card-nm">{item.displayName}</div>
        <div className="sf-card-meta">
          <span className="cat">{item.categoryLabel ?? 'Uncategorized'}</span>
        </div>
        {item.publicDescription ? (
          <p className="sfp-desc" title={item.publicDescription}>
            {item.publicDescription}
          </p>
        ) : null}
        <div className="sf-card-ctl">
          {out && qty === 0 ? (
            // Unavailable-but-visible: disabled state instead of an add button.
            <button type="button" className="sf-add oos" disabled>
              Unavailable
            </button>
          ) : qty === 0 ? (
            <button type="button" className="sf-add" onClick={() => onAdd(item.id)}>
              <Plus size={13} /> Add to request
            </button>
          ) : (
            <div className="sf-step">
              <button type="button" onClick={() => onDec(item.id)} aria-label="Decrease">
                <Minus size={13} />
              </button>
              <QtyField
                itemId={item.id}
                qty={qty}
                available={cap}
                onSetQty={onSetQty}
                showInCartLabel
              />
              <button
                type="button"
                onClick={() => onAdd(item.id)}
                disabled={atMax}
                title={
                  atMax
                    ? item.maxQty !== null && cap === item.maxQty
                      ? `Limit ${item.maxQty} per request`
                      : 'All available stock is in your request'
                    : 'Increase'
                }
                aria-label="Increase"
              >
                <Plus size={13} />
              </button>
            </div>
          )}
          {item.maxQty !== null ? (
            <div className="sfp-limit">Limit {item.maxQty} per request</div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
