'use client';

import { Plus } from 'lucide-react';
import * as React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useCart } from './cart-context';

interface FreqItem {
  itemId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  imageUrl: string | null;
  available: number;
  quantityOnHand: number;
  count: number;
}

interface QuickAddProps {
  warehouseId: string;
}

export function QuickAdd({ warehouseId }: QuickAddProps) {
  const { dispatch } = useCart();
  const [items, setItems] = React.useState<FreqItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setLoading(true);
    setFailed(false);
    setItems([]);

    fetch(`/api/orders/freq?warehouseId=${encodeURIComponent(warehouseId)}&limit=6`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const body = (await res.json()) as { items: FreqItem[] };
        if (!cancelled) setItems(body.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  // Hide on error
  if (failed) return null;
  // Hide when loaded but empty
  if (!loading && items.length === 0) return null;

  function handleAdd(item: FreqItem) {
    if (item.available <= 0) return;
    dispatch({ type: 'add', itemId: item.itemId });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Frequently ordered
      </h3>
      <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <Skeleton
                key={i}
                className="flex-none w-28 h-32 rounded-lg"
              />
            ))
          : items.map((item) => (
              <QuickAddCard
                key={item.itemId}
                item={item}
                onAdd={() => handleAdd(item)}
              />
            ))}
      </div>
    </div>
  );
}

function QuickAddCard({
  item,
  onAdd,
}: {
  item: FreqItem;
  onAdd: () => void;
}) {
  const { state } = useCart();
  const inCart = state.lines.some((l) => l.itemId === item.itemId);
  const disabled = item.available <= 0;

  return (
    <div
      className={cn(
        'flex-none w-28 flex flex-col rounded-lg border bg-card overflow-hidden',
        inCart && 'border-emerald-500',
      )}
    >
      {/* Mini thumbnail */}
      <div className="aspect-square w-full bg-muted overflow-hidden relative">
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
          <div className="h-full w-full flex items-center justify-center bg-muted">
            <span className="text-2xl font-serif text-muted-foreground/40 select-none">
              {item.name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        )}
        {inCart && (
          <div className="absolute inset-0 bg-emerald-500/10 flex items-center justify-center">
            <span className="text-emerald-600 text-[10px] font-semibold">In cart</span>
          </div>
        )}
      </div>

      {/* Name + Add */}
      <div className="p-1.5 flex flex-col gap-1 flex-1">
        <p className="text-[10px] font-medium leading-tight line-clamp-2" title={item.name}>
          {item.name}
        </p>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className={cn(
            'mt-auto flex items-center justify-center gap-0.5 w-full rounded py-1 text-[10px] font-medium transition-colors',
            disabled
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : inCart
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-foreground text-background hover:bg-foreground/80',
          )}
          aria-label={`Add ${item.name} to cart`}
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
    </div>
  );
}
