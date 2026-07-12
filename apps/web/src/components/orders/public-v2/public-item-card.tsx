'use client';

// Public catalog card — the sf-card visual from the internal storefront
// (owner request: the public page must look like /dashboard/orders/new),
// rendered from the narrow PublicCatalogItem schema. No SKU, price,
// charter, or location ever appears here because the type doesn't carry
// them.

import { Minus, Plus } from 'lucide-react';
import Image from 'next/image';
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

/**
 * Photo box: optimized image → LQIP blur → serif letter glyph.
 *
 * Renders through next/image so Vercel's optimizer downscales the SHARP
 * source (full-size Open Library cover, or the item's master photo) to the
 * exact 220-260px card cell as WebP/AVIF. That fixes the blur that a raw
 * <img> showed — the SSR/deferred sources are 400-2048px, far larger than
 * the cell, and a plain <img> was previously fed 180-200px thumbnails that
 * upscaled ~2.5× on retina. `sizes` matches the grid (2-up under 560px,
 * ~240px cells above); the first row loads at priority for LCP.
 */
export function PublicPhoto({ item, priority }: { item: PublicCatalogItem; priority?: boolean }) {
  if (item.imageUrl) {
    return (
      <div className="sf-ph">
        <Image
          src={item.imageUrl}
          alt={item.displayName}
          fill
          sizes="(max-width: 560px) 45vw, 240px"
          priority={priority}
          style={{ objectFit: 'cover' }}
          {...(item.lqip ? { placeholder: 'blur' as const, blurDataURL: item.lqip } : {})}
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
