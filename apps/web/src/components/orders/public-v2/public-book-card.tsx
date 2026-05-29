'use client';

import { Minus, Plus } from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

import { useCart } from '@/components/orders/v2/cart-context';
import type { CatalogItem } from '@/components/orders/v2/types';
import { cn } from '@/lib/utils';

/**
 * Public-portal book card: a tall editorial cover + Add→stepper.
 *
 * Uses the real cover image when the book has one; otherwise renders a
 * generated typeset cover (a colored spine keyed off the title). This is
 * the public-link variant — the staff order picker keeps using ItemCard,
 * so this styling never bleeds into the dashboard.
 */

// Editorial cover palettes [background, ink] — deterministic per title.
const COVER_PALETTE: Array<[string, string]> = [
  ['#5b2330', '#f3e6d6'],
  ['#1f3b30', '#e7efe2'],
  ['#1d2b46', '#dfe6f2'],
  ['#3b2545', '#ecdcf0'],
  ['#a14a2a', '#f6e7da'],
  ['#34403f', '#e3ebe8'],
  ['#1b4a4a', '#dcefec'],
  ['#7c4a3a', '#f1e2d6'],
  ['#1f2a1c', '#e7efe2'],
  ['#caa242', '#2a2008'],
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function PublicBookCard({ item }: { item: CatalogItem }) {
  const { state, dispatch } = useCart();

  const available = Math.max(0, item.quantityOnHand - item.reservedQuantity);
  const out = available <= 0;
  const low = !out && available <= 10;
  const availLabel = out ? 'Out' : low ? `${available} left` : `${available} avail`;

  const cartLine = state.lines.find((l) => l.itemId === item.id);
  const qty = cartLine?.quantity ?? 0;
  const inCart = qty > 0;

  const palette = COVER_PALETTE[hashStr(item.name) % COVER_PALETTE.length];
  const [bg, ink] = palette ?? ['#1f2a1c', '#e7efe2'];

  return (
    <article className="flex flex-col">
      {/* Cover */}
      <div
        className="relative aspect-[3/4.1] overflow-hidden rounded-lg border border-black/10 shadow-sm dark:border-white/10"
        style={item.imageUrl ? undefined : { backgroundColor: bg, color: ink }}
      >
        {item.imageUrl ? (
          <>
            {item.lqip ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.lqip}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-110 object-cover"
              />
            ) : null}
            <Image
              src={item.imageUrl}
              alt=""
              fill
              sizes="(max-width: 640px) 50vw, 220px"
              loading="lazy"
              className="object-cover opacity-0 transition-opacity duration-300 [&.loaded]:opacity-100"
              onLoad={(e) => (e.currentTarget as HTMLImageElement).classList.add('loaded')}
            />
          </>
        ) : (
          // Generated typeset cover when no photo exists.
          <div className="flex h-full flex-col justify-between p-4">
            <div className="font-serif text-[17px] font-bold leading-[1.12] line-clamp-5 [text-wrap:balance]">
              {item.name}
            </div>
            <div>
              <div className="mb-2 h-0.5 w-6 bg-current opacity-50" />
              <div className="font-mono text-[10px] opacity-70">{item.sku}</div>
            </div>
          </div>
        )}

        {/* Availability badge */}
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 font-mono text-[10px] leading-none text-white backdrop-blur-sm">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              out ? 'bg-red-400' : low ? 'bg-amber-400' : 'bg-emerald-400',
            )}
          />
          {availLabel}
        </span>

        {inCart ? (
          <span className="bg-primary text-primary-foreground absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none">
            ×{qty}
          </span>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-2 pt-2.5">
        <div>
          <h4 className="line-clamp-2 text-[13.5px] font-medium leading-tight" title={item.name}>
            {item.name}
          </h4>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">{item.sku}</p>
        </div>

        <div className="mt-auto">
          {inCart ? (
            <div className="border-primary bg-primary/10 grid h-9 grid-cols-[2.25rem_1fr_2.25rem] items-center overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => dispatch({ type: 'dec', itemId: item.id })}
                className="text-primary hover:bg-primary/15 grid h-full place-items-center"
                aria-label="Remove one"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="text-center font-mono text-[13px] tabular-nums">{qty}</span>
              <button
                type="button"
                onClick={() => {
                  // Clamp to AVAILABLE (on-hand minus reserved), matching the
                  // availability badge — not gross quantityOnHand, which would
                  // let a requester step past the "N avail" the card shows.
                  if (qty < available) dispatch({ type: 'inc', itemId: item.id });
                }}
                disabled={qty >= available}
                className="text-primary hover:bg-primary/15 grid h-full place-items-center disabled:opacity-40"
                aria-label="Add one"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!out) dispatch({ type: 'add', itemId: item.id });
              }}
              disabled={out}
              className="border-input bg-background hover:bg-muted flex h-9 w-full items-center justify-center gap-1.5 rounded-md border text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              {out ? (
                'Unavailable'
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" /> Add to request
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
