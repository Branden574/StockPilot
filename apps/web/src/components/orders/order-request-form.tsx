'use client';

import { Loader2, Minus, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createOrderRequestAction } from '@/server/actions/order-requests';
import { formatNumber } from '@/lib/utils';

export interface OrderItemOption {
  id: string;
  name: string;
  sku: string;
  warehouseId: string;
  quantityOnHand: number;
  reservedQuantity: number;
}

interface CartLine {
  itemId: string;
  itemName: string;
  itemSku: string;
  quantity: number;
  available: number;
}

interface Props {
  warehouses: Array<{ id: string; name: string }>;
  warehouseId: string;
  /** Items pre-loaded for the current warehouse on the server. Switching
      warehouse triggers a navigation so the server reloads the correct
      slice — keeps the form simple, no per-warehouse client cache. */
  items: OrderItemOption[];
}

export function OrderRequestForm({ warehouses, warehouseId, items }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = React.useState('');
  const [cart, setCart] = React.useState<Map<string, CartLine>>(new Map());
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  function changeWarehouse(nextId: string) {
    if (nextId === warehouseId) return;
    setCart(new Map());
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('warehouseId', nextId);
    router.push(`/dashboard/orders/new?${params.toString()}`);
  }

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q),
    );
  }, [items, search]);

  function availableToPromise(item: OrderItemOption): number {
    return Math.max(0, item.quantityOnHand - item.reservedQuantity);
  }

  function addOne(item: OrderItemOption) {
    setCart((prev) => {
      const next = new Map(prev);
      const existing = next.get(item.id);
      const available = availableToPromise(item);
      if (available <= 0) {
        toast.info(`${item.name} has no available stock.`);
        return prev;
      }
      const nextQty = (existing?.quantity ?? 0) + 1;
      if (nextQty > available) {
        toast.info(`Only ${formatNumber(available)} available.`);
        return prev;
      }
      next.set(item.id, {
        itemId: item.id,
        itemName: item.name,
        itemSku: item.sku,
        quantity: nextQty,
        available,
      });
      return next;
    });
  }

  function setQty(itemId: string, qty: number) {
    setCart((prev) => {
      const next = new Map(prev);
      const line = next.get(itemId);
      if (!line) return prev;
      if (qty <= 0) {
        next.delete(itemId);
        return next;
      }
      const clamped = Math.min(qty, line.available);
      next.set(itemId, { ...line, quantity: clamped });
      return next;
    });
  }

  function removeFromCart(itemId: string) {
    setCart((prev) => {
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  }

  const cartLines = Array.from(cart.values());
  const totalQty = cartLines.reduce((s, l) => s + l.quantity, 0);

  async function submit() {
    if (!warehouseId) {
      toast.error('Pick a warehouse.');
      return;
    }
    if (cartLines.length === 0) {
      toast.error('Add at least one item to your request.');
      return;
    }
    setSubmitting(true);
    const res = await createOrderRequestAction({
      warehouseId,
      notes: notes.trim() || null,
      lines: cartLines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Order request submitted.');
    router.push(`/dashboard/orders/${res.data.id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <section className="bg-card rounded-xl border p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Warehouse</Label>
              <Select
                value={warehouseId}
                onValueChange={changeWarehouse}
                disabled={submitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="search">Search items</Label>
              <div className="relative">
                <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-3.5 w-3.5" />
                <Input
                  id="search"
                  className="pl-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name or SKU"
                  disabled={submitting}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl border">
          <div className="border-border border-b px-4 py-3">
            <h2 className="text-sm font-medium">
              Items ({formatNumber(filtered.length)})
            </h2>
            <p className="text-muted-foreground mt-0.5 text-[11.5px]">
              Available-to-promise = on hand minus active reservations.
            </p>
          </div>
          <div className="max-h-[520px] divide-y overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-muted-foreground p-8 text-center text-sm">
                {items.length === 0
                  ? 'No active items in this warehouse.'
                  : 'No items match your search.'}
              </div>
            ) : (
              filtered.map((it) => {
                const available = availableToPromise(it);
                const inCart = cart.get(it.id);
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{it.name}</div>
                      <div className="text-muted-foreground truncate font-mono text-[11px]">
                        {it.sku}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tabular-nums text-xs">
                        {formatNumber(available)} avail
                      </div>
                      <div className="text-muted-foreground text-[10.5px] tabular-nums">
                        {formatNumber(it.quantityOnHand)} on hand
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant={inCart ? 'outline' : 'gradient'}
                      size="sm"
                      onClick={() => addOne(it)}
                      disabled={submitting || available <= 0}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {inCart ? `In cart (${formatNumber(inCart.quantity)})` : 'Add'}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="bg-card space-y-3 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <ShoppingCart className="text-muted-foreground h-4 w-4" />
            <h2 className="text-sm font-medium">
              Cart ({formatNumber(cartLines.length)})
            </h2>
          </div>

          {cartLines.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Your cart is empty. Add items from the list.
            </p>
          ) : (
            <ul className="divide-y">
              {cartLines.map((l) => (
                <li key={l.itemId} className="space-y-1 py-2 text-xs">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{l.itemName}</div>
                      <div className="text-muted-foreground truncate font-mono text-[10.5px]">
                        {l.itemSku}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => removeFromCart(l.itemId)}
                      aria-label="Remove from cart"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => setQty(l.itemId, l.quantity - 1)}
                      disabled={submitting}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      max={l.available}
                      value={l.quantity}
                      onChange={(e) =>
                        setQty(l.itemId, Math.max(0, Number(e.target.value) || 0))
                      }
                      className="h-7 w-16 text-center"
                      disabled={submitting}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => setQty(l.itemId, l.quantity + 1)}
                      disabled={submitting}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                    <span className="text-muted-foreground ml-auto tabular-nums text-[10.5px]">
                      / {formatNumber(l.available)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="border-border border-t pt-3">
            <Label htmlFor="order-notes" className="text-xs">
              Notes for the manager (optional)
            </Label>
            <Textarea
              id="order-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Anything the manager should know"
              disabled={submitting}
              className="mt-1.5"
            />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Total qty</span>
            <span className="tabular-nums font-semibold">
              {formatNumber(totalQty)}
            </span>
          </div>

          <Button
            type="button"
            variant="gradient"
            className="w-full"
            onClick={submit}
            disabled={submitting || cartLines.length === 0}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Submit request
          </Button>
        </div>
      </aside>
    </div>
  );
}
