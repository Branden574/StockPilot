'use client';

import {
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  Truck,
} from 'lucide-react';
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
import { cn, formatNumber } from '@/lib/utils';
import { createOrderRequestAction } from '@/server/actions/order-requests';

import { isManagerOrAbove, type Role } from '@stockpilot/core';

export interface OrderItemOption {
  id: string;
  name: string;
  sku: string;
  warehouseId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  itemType: string | null;
  /** Pre-rendered rack label (e.g. "38-A" or "12-C · red4"). null when
      the item has no rack assigned. Helps disambiguate duplicates that
      share name + SKU but live at different racks. */
  rackLabel: string | null;
  /** Primary thumbnail URL. Either a signed item_images URL (uploaded
      via the dashboard) or a custom_fields.thumbnail_url (bulk-imported
      books from the ISBN importer). null = no photo on file. */
  imageUrl: string | null;
}

type TypeFilter = 'all' | 'book' | 'product';

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
  /** Sites the active warehouse services — populates the delivery
      dropdown. Server-fetched against `warehouse_charters` so the
      requester can only point a delivery at a site this warehouse
      actually covers. */
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
  /** Caller's role — needed to gate the "Create on behalf of" manager
      affordance. Passed from the server component so we don't have to
      re-fetch it client-side. */
  viewerRole: Role;
}

export function OrderRequestForm({
  warehouses,
  warehouseId,
  items,
  chartersForWarehouse,
  viewerRole,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [cart, setCart] = React.useState<Map<string, CartLine>>(new Map());
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [fulfillmentType, setFulfillmentType] = React.useState<
    'pickup' | 'delivery'
  >('delivery');
  const [phone, setPhone] = React.useState('');
  const [deliveryCharterId, setDeliveryCharterId] = React.useState<string>('');
  const [pickupNotes, setPickupNotes] = React.useState('');
  const [onBehalfOf, setOnBehalfOf] = React.useState<
    { name: string; email: string } | null
  >(null);
  const canActOnBehalf = isManagerOrAbove(viewerRole);

  function changeWarehouse(nextId: string) {
    if (nextId === warehouseId) return;
    setCart(new Map());
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('warehouseId', nextId);
    router.push(`/dashboard/orders/new?${params.toString()}`);
  }

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (typeFilter === 'book' && it.itemType !== 'book') return false;
      // 'product' bucket = anything that isn't a book. Keeps the chip
      // simple for orgs that don't use the asset/consumable types.
      if (typeFilter === 'product' && it.itemType === 'book') return false;
      if (!q) return true;
      return (
        it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q)
      );
    });
  }, [items, search, typeFilter]);

  const counts = React.useMemo(() => {
    let books = 0;
    let products = 0;
    for (const it of items) {
      if (it.itemType === 'book') books += 1;
      else products += 1;
    }
    return { all: items.length, book: books, product: products };
  }, [items]);

  function availableToPromise(item: OrderItemOption): number {
    return Math.max(0, item.quantityOnHand - item.reservedQuantity);
  }

  function addOne(item: OrderItemOption) {
    setCart((prev) => {
      const next = new Map(prev);
      const existing = next.get(item.id);
      const available = availableToPromise(item);
      if (available <= 0) {
        toast.info(`"${item.name}" has no available stock right now.`);
        return prev;
      }
      const nextQty = (existing?.quantity ?? 0) + 1;
      if (nextQty > available) {
        toast.info(`Only ${formatNumber(available)} available to request.`);
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
      toast.error('Pick a warehouse to order from.');
      return;
    }
    if (cartLines.length === 0) {
      toast.error('Add at least one item to your request before submitting.');
      return;
    }
    if (fulfillmentType === 'delivery' && !deliveryCharterId) {
      toast.error('Pick a delivery site.');
      return;
    }
    if (onBehalfOf) {
      if (!onBehalfOf.name.trim() || !onBehalfOf.email.trim()) {
        toast.error("Add the requester's name and email, or uncheck the toggle.");
        return;
      }
    }
    setSubmitting(true);
    const res = await createOrderRequestAction({
      warehouseId,
      notes: notes.trim() || null,
      fulfillmentType,
      requesterPhone: phone.trim() || null,
      deliveryCharterId:
        fulfillmentType === 'delivery' ? deliveryCharterId : null,
      pickupLocationNotes:
        fulfillmentType === 'pickup' ? pickupNotes.trim() || null : null,
      onBehalfOf: onBehalfOf
        ? { name: onBehalfOf.name.trim(), email: onBehalfOf.email.trim() }
        : null,
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

        {canActOnBehalf ? (
          <section className="border-border bg-card space-y-3 rounded-2xl border p-5">
            <Label
              htmlFor="ior-onbehalf-toggle"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <input
                id="ior-onbehalf-toggle"
                type="checkbox"
                checked={onBehalfOf !== null}
                onChange={(e) =>
                  setOnBehalfOf(
                    e.target.checked ? { name: '', email: '' } : null,
                  )
                }
                disabled={submitting}
              />
              <span>Create on behalf of someone else</span>
            </Label>
            {onBehalfOf !== null ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ior-onbehalf-name">Their name</Label>
                  <Input
                    id="ior-onbehalf-name"
                    value={onBehalfOf.name}
                    onChange={(e) =>
                      setOnBehalfOf((s) =>
                        s ? { ...s, name: e.target.value } : s,
                      )
                    }
                    required
                    maxLength={120}
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ior-onbehalf-email">Their email</Label>
                  <Input
                    id="ior-onbehalf-email"
                    type="email"
                    value={onBehalfOf.email}
                    onChange={(e) =>
                      setOnBehalfOf((s) =>
                        s ? { ...s, email: e.target.value } : s,
                      )
                    }
                    required
                    maxLength={254}
                    disabled={submitting}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  The order will be tracked against this requester&apos;s email,
                  and they&apos;ll receive the same status emails as a public
                  submitter.
                </p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="border-border bg-card space-y-4 rounded-2xl border p-5">
          <h2 className="text-sm font-medium">How should we get this to you?</h2>
          <div
            role="radiogroup"
            aria-label="Fulfillment type"
            className="flex gap-3"
          >
            <button
              type="button"
              role="radio"
              aria-checked={fulfillmentType === 'pickup'}
              onClick={() => setFulfillmentType('pickup')}
              disabled={submitting}
              className={cn(
                'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
                fulfillmentType === 'pickup' && 'border-primary bg-primary/5',
              )}
            >
              <Package
                className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
                aria-hidden
              />
              <div>
                <div className="font-medium">Pickup</div>
                <div className="text-muted-foreground mt-1 text-xs">
                  I&apos;ll come to the warehouse.
                </div>
              </div>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={fulfillmentType === 'delivery'}
              onClick={() => setFulfillmentType('delivery')}
              disabled={submitting}
              className={cn(
                'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
                fulfillmentType === 'delivery' && 'border-primary bg-primary/5',
              )}
            >
              <Truck
                className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
                aria-hidden
              />
              <div>
                <div className="font-medium">Delivery</div>
                <div className="text-muted-foreground mt-1 text-xs">
                  Bring it to me.
                </div>
              </div>
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ior-phone">
              Phone
              <span className="text-muted-foreground ml-1 font-normal">
                (optional)
              </span>
            </Label>
            <Input
              id="ior-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              autoComplete="tel"
              maxLength={40}
              disabled={submitting}
            />
          </div>

          {fulfillmentType === 'delivery' ? (
            <div className="bg-muted/40 space-y-3 rounded-xl p-4">
              <div className="space-y-1.5">
                <Label htmlFor="ior-delivery-site">Deliver to which site?</Label>
                {chartersForWarehouse.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    No delivery sites are configured for this warehouse yet. Ask the
                    warehouse to add some, or choose Pickup instead.
                  </p>
                ) : (
                  <Select
                    value={deliveryCharterId}
                    onValueChange={setDeliveryCharterId}
                    disabled={submitting}
                  >
                    <SelectTrigger id="ior-delivery-site">
                      <SelectValue placeholder="Pick a site" />
                    </SelectTrigger>
                    <SelectContent>
                      {chartersForWarehouse.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                          {c.code ? ` (${c.code})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-muted-foreground text-xs">
                  We&apos;ll bring the order to this site. Your contact info above (name,
                  email, phone) is how we&apos;ll reach you about the delivery.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="ior-pickup-notes">
                Pickup notes
                <span className="text-muted-foreground ml-1 font-normal">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="ior-pickup-notes"
                value={pickupNotes}
                onChange={(e) => setPickupNotes(e.target.value)}
                placeholder="When you'll come by, who's picking up, etc."
                rows={2}
                maxLength={2000}
                disabled={submitting}
              />
            </div>
          )}
        </section>

        <section className="bg-card rounded-xl border">
          <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-medium">
                Items ({formatNumber(filtered.length)})
              </h2>
              <p className="text-muted-foreground mt-0.5 text-[11.5px]">
                Available-to-promise = on hand minus active reservations.
              </p>
            </div>
            <div className="border-border bg-background flex items-center gap-1 rounded-md border p-0.5 text-xs">
              <FilterChip
                active={typeFilter === 'all'}
                onClick={() => setTypeFilter('all')}
              >
                All ({formatNumber(counts.all)})
              </FilterChip>
              <FilterChip
                active={typeFilter === 'book'}
                onClick={() => setTypeFilter('book')}
              >
                Books ({formatNumber(counts.book)})
              </FilterChip>
              <FilterChip
                active={typeFilter === 'product'}
                onClick={() => setTypeFilter('product')}
              >
                Items ({formatNumber(counts.product)})
              </FilterChip>
            </div>
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
                    {/* Thumbnail. Plain <img> rather than next/image:
                        signed URLs and arbitrary public CDN (bulk-import)
                        sources don't pass through the image optimizer,
                        and the list can be 500+ rows so a 40×40 raw img
                        is the right cost profile. lazy = browser only
                        decodes rows scrolled into view. */}
                    <div className="border-border bg-muted h-10 w-10 flex-none overflow-hidden rounded-md border">
                      {it.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={it.imageUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{it.name}</div>
                      <div className="text-muted-foreground truncate font-mono text-[11px]">
                        {it.sku}
                        {it.rackLabel ? (
                          <span className="ml-2 font-sans">· Rack {it.rackLabel}</span>
                        ) : null}
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ' +
        (active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-muted')
      }
    >
      {children}
    </button>
  );
}
