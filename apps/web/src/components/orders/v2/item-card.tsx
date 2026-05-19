'use client';

import { MapPin, Minus, Plus } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn, formatCurrency } from '@/lib/utils';

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

  const priceDisplay =
    item.price !== null ? formatCurrency(item.price) : '—';

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
      {/* Thumbnail area */}
      <div className="relative aspect-square w-full bg-muted overflow-hidden">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          // Placeholder: serif glyph over CSS pinstripes
          <div
            className="h-full w-full flex items-center justify-center"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0,0,0,.04) 3px, rgba(0,0,0,.04) 6px)',
            }}
          >
            <span className="text-4xl font-serif text-muted-foreground/40 select-none">
              {item.name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        )}

        {/* Ink price tag — notched left edge via pseudo-element */}
        <div
          className={cn(
            'absolute top-2 right-0 flex items-center',
            'bg-foreground text-background text-[11px] font-semibold leading-none',
            'pl-2 pr-2 py-1 rounded-l-sm',
            // The notch: a triangle cut out of the left side
            'before:content-[""] before:absolute before:left-[-6px] before:top-0 before:bottom-0 before:w-[6px]',
            'before:bg-[linear-gradient(135deg,transparent_50%,var(--tw-bg-foreground,hsl(var(--foreground)))_50%)]',
          )}
          style={
            {
              '--tw-bg-foreground': 'hsl(var(--foreground))',
            } as React.CSSProperties
          }
        >
          {priceDisplay}
        </div>

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
