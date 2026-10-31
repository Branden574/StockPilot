'use client';

import { MapPin, Minus, Plus } from 'lucide-react';
import Image from 'next/image';
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

  function handleSetQty(raw: string) {
    // Empty string while typing — leave the line at its current qty
    // until the user commits a real number. Saves us from yanking the
    // line out from under the user mid-edit.
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(item.quantityOnHand, Math.floor(n)));
    dispatch({ type: 'set-qty', itemId: item.id, quantity: clamped });
  }

  const stockLabel =
    status === 'out'
      ? 'Out'
      : status === 'low'
        ? `${available} low`
        : `${available} avail`;

  // The status label's tone (DESIGN-SPEC 6.10): wash, tone text and a dot in
  // the text colour; the words carry the meaning, never the colour alone.
  const stockToneClass =
    status === 'out'
      ? 'bg-destructive-wash text-destructive'
      : status === 'low'
        ? 'bg-warning-wash text-warning'
        : 'bg-success-wash text-success';

  return (
    <article
      className={cn(
        'relative flex flex-col overflow-hidden rounded-lg border bg-background transition-colors hover:border-ink-4',
        inCart && 'border-accent shadow-[0_0_0_1px_hsl(var(--accent))] hover:border-accent',
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
      <div className="relative aspect-square w-full overflow-hidden border-b bg-sunk">
        {/* Layer 1 — always: serif glyph over pinstripes */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, var(--ed-line) 0 1px, transparent 1px 6px)',
          }}
        >
          <span className="font-display text-ink-4 select-none text-4xl font-medium">
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

        {/* Layer 3 — real photo; fades in once URL arrives.
            Routed through next/image so Supabase signed-URL thumbnails
            get AVIF/WebP transcoding + edge cache (24h per next.config
            minimumCacheTTL). The fill + sizes hints let the optimizer
            pick the right transform size for the grid cell — typical
            sm:grid-cols-2 → md:4 → lg:6 layout means ~25vw on tablet
            and ~16vw on desktop. The fade-in onLoad handler is
            preserved exactly — next/image renders an underlying <img>
            and surfaces its load event the same way. */}
        {item.imageUrl ? (
          <Image
            src={item.imageUrl}
            alt=""
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px"
            loading="lazy"
            className="object-cover opacity-0 transition-opacity duration-300 [&.loaded]:opacity-100"
            onLoad={(e) => (e.currentTarget as HTMLImageElement).classList.add('loaded')}
          />
        ) : null}

        {/* In-cart badge on thumbnail */}
        {inCart && (
          <div className="bg-foreground text-background absolute bottom-2 right-2 rounded-full px-2 font-mono text-[11px] font-medium leading-[18px]">
            ×{qty}
          </div>
        )}

        {/* Stock pill: the status label (no blur, DESIGN-SPEC 6.10) */}
        <div
          className={cn(
            'absolute bottom-2 left-2 flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] leading-[18px]',
            stockToneClass,
          )}
        >
          <span className="h-[5px] w-[5px] flex-none rounded-full bg-current" />
          <span>{stockLabel}</span>
        </div>
      </div>

      {/* Card body */}
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h4
          className="line-clamp-2 text-[13.5px] font-medium leading-[1.35]"
          title={item.name}
        >
          {item.name}
        </h4>
        <p
          className="text-muted-foreground truncate font-mono text-[11.5px]"
          title={item.categoryName ? `${item.sku} · ${item.categoryName}` : item.sku}
        >
          {item.sku}
          {item.categoryName ? (
            <span className="font-sans"> · {item.categoryName}</span>
          ) : null}
        </p>
        {/* Charter ribbon — only shown when the item is earmarked for a
            specific charter so generic stock cards stay clean. Prefers
            the short charter code; falls back to the full name. */}
        {item.charterId ? (
          <p
            className="text-muted-foreground truncate font-sans text-[11px]"
            title={item.charterName ?? undefined}
          >
            Charter ·{' '}
            <span className="text-ink-2">
              {item.charterCode ?? item.charterName}
            </span>
          </p>
        ) : null}

        <div className="border-border mt-auto border-t pt-2">
          <div className="flex items-center justify-between gap-2">
            {/* Bin location */}
            {item.rackLabel ? (
              <div
                className="text-muted-foreground flex min-w-0 items-center gap-1 truncate text-[11px]"
                title={item.rackLabel}
              >
                <MapPin className="h-3 w-3 flex-none" />
                <span className="truncate">{item.rackLabel}</span>
              </div>
            ) : (
              <div />
            )}

            {/* Add / Stepper. The stepper's width is held only while the
                item is in the cart, so the Add button leaves the rack label
                the room it does not need (a narrow card cut it to "1."). */}
            <div className={cn('flex flex-none justify-end', inCart && 'min-w-[5.5rem]')}>
              {inCart ? (
                <div className="border-line-strong bg-card flex h-7 items-center overflow-hidden rounded-md border focus-within:border-accent focus-within:shadow-[0_0_0_1px_hsl(var(--accent))]">
                  <button
                    type="button"
                    onClick={handleDec}
                    className="flex items-center justify-center w-7 h-7 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={item.quantityOnHand}
                    step={1}
                    value={qty}
                    onChange={(e) => handleSetQty(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-7 w-7 bg-transparent text-center font-mono text-[12.5px] font-medium tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    aria-label="Quantity"
                  />
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
                  className="h-7 px-2.5 text-[12.5px]"
                >
                  {/* The button's own gap spaces the icon from the word. */}
                  <Plus className="h-3 w-3" />
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
