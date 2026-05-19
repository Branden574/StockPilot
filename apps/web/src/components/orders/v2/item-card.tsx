'use client';

import { MapPin, Minus, Plus } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { useCart } from './cart-context';
import type { CatalogItem } from './types';

interface ItemCardProps {
  item: CatalogItem;
}

function stockStatus(available: number, reorderPoint: number) {
  if (available === 0) return 'out' as const;
  if (available < reorderPoint) return 'low' as const;
  return 'in' as const;
}

export function ItemCard({ item }: ItemCardProps) {
  const { state, dispatch } = useCart();

  const available = Math.max(0, item.quantityOnHand - item.reservedQuantity);
  const status = stockStatus(available, item.reorderPoint);

  const cartLine = state.lines.find((l) => l.itemId === item.id);
  const qty = cartLine?.quantity ?? 0;
  const inCart = qty > 0;

  function handleAdd() {
    if (available <= 0) return;
    dispatch({ type: 'add', itemId: item.id });
  }

  function handleInc() {
    if (qty >= item.quantityOnHand) return;
    dispatch({ type: 'inc', itemId: item.id });
  }

  function handleDec() {
    dispatch({ type: 'dec', itemId: item.id });
  }

  const stockLabel =
    status === 'out'
      ? 'Out'
      : status === 'low'
        ? `${available} low`
        : `${available} avail`;

  const stockDotClass =
    status === 'out'
      ? 'bg-red-500'
      : status === 'low'
        ? 'bg-orange-400'
        : 'bg-emerald-500';

  return (
    <article
      className={cn(
        'relative flex flex-col rounded-lg border bg-card overflow-hidden',
        inCart &&
          'border-emerald-500 shadow-[inset_0_0_0_1px_rgb(16_185_129)]',
      )}
    >
      {/* Thumbnail area.
          Layer order (bottom → top):
            1. Pinstripe + serif-letter placeholder (always there)
            2. LQIP blur (when item has any item_images row)
            3. Real photo (once /api/orders/catalog-thumbnails resolves)
          The crossfade is `transition-opacity duration-300` — by the
          time the real photo decodes, the blur underneath has already
          painted, so the swap looks like a gentle focus-in instead of
          a stark placeholder-to-photo pop. */}
      <div className="relative aspect-square w-full bg-muted overflow-hidden">
        {/* Layer 1 — always: serif glyph over pinstripes */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0,0,0,.04) 3px, rgba(0,0,0,.04) 6px)',
          }}
        >
          <span className="text-4xl font-serif text-muted-foreground/40 select-none">
            {item.name.slice(0, 1).toUpperCase()}
          </span>
        </div>

        {/* Layer 2 — LQIP blur (covers the letter the moment the card
            paints, so items WITH a photo never show the stark letter).
            scale-110 prevents the bilinear-upscale edges from peeking
            past the card border. */}
        {item.lqip ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.lqip}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover scale-110"
          />
        ) : null}

        {/* Layer 3 — real photo; fades in once URL arrives */}
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-300 [&.loaded]:opacity-100"
            onLoad={(e) => e.currentTarget.classList.add('loaded')}
          />
        ) : null}

        {/* In-cart badge on thumbnail */}
        {inCart && (
          <div className="absolute bottom-1 right-1 bg-emerald-500 text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none">
            ×{qty}
          </div>
        )}

        {/* Stock pill — glass blur */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 backdrop-blur-md bg-card/70 px-2 py-1 rounded-full text-[10px] leading-none">
          <span className={cn('h-1.5 w-1.5 rounded-full flex-none', stockDotClass)} />
          <span className={cn(
            status === 'out' ? 'text-red-600 dark:text-red-400' :
            status === 'low' ? 'text-orange-600 dark:text-orange-400' :
            'text-emerald-700 dark:text-emerald-400',
            'font-medium',
          )}>
            {stockLabel}
          </span>
        </div>
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-1 p-3 flex-1">
        <h4
          className="text-sm font-medium leading-snug line-clamp-2"
          title={item.name}
        >
          {item.name}
        </h4>
        <p className="font-mono text-[10px] text-muted-foreground truncate">
          {item.sku}
          {item.categoryName ? (
            <span className="font-sans"> · {item.categoryName}</span>
          ) : null}
        </p>

        <div className="mt-auto pt-2 border-t border-border/50">
          <div className="flex items-center justify-between gap-2">
            {/* Bin location */}
            {item.rackLabel ? (
              <div
                className="flex items-center gap-1 text-[10px] text-muted-foreground truncate min-w-0"
                title={item.rackLabel}
              >
                <MapPin className="h-3 w-3 flex-none" />
                <span className="truncate">{item.rackLabel}</span>
              </div>
            ) : (
              <div />
            )}

            {/* Add / Stepper */}
            <div className="flex-none min-w-[5.5rem] flex justify-end">
              {inCart ? (
                <div className="flex items-center border border-border rounded-md overflow-hidden h-7">
                  <button
                    type="button"
                    onClick={handleDec}
                    className="flex items-center justify-center w-7 h-7 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="w-7 text-center text-xs font-semibold tabular-nums">
                    {qty}
                  </span>
                  <button
                    type="button"
                    onClick={handleInc}
                    disabled={qty >= item.quantityOnHand}
                    className="flex items-center justify-center w-7 h-7 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Increase quantity"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAdd}
                  disabled={available <= 0}
                  className="h-7 px-3 text-xs"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
