'use client';

import { Minus, Package, Plus, ShoppingCart, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { cn } from '@/lib/utils';

interface BookSummary {
  id: string;
  name: string;
  author: string | null;
  quantityOnHand: number;
  imageUrl: string | null;
}

interface WarehouseSummary {
  id: string;
  name: string;
}

interface CharterSummary {
  id: string;
  name: string;
  code: string | null;
}

interface Props {
  token: string;
  orgName: string;
  warehouses: WarehouseSummary[];
  initialWarehouseId: string;
  initialBooks: BookSummary[];
  chartersForWarehouse: CharterSummary[];
}

interface SubmittedState {
  id: string;
  email: string;
  trackUrl: string;
}

/**
 * Public-link order request form. All inputs are unauthenticated; the
 * server enforces token + warehouse + item validity. Renders three
 * sections in order: requester info → book grid w/ qty steppers →
 * notes + submit. The cart lives in component state — a Map<itemId, qty>
 * — and the submit button sticks to the bottom of the viewport on
 * mobile so it's always one tap away.
 */
export function PublicOrderForm({
  token,
  orgName,
  warehouses,
  initialWarehouseId,
  initialBooks,
  chartersForWarehouse,
}: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [orgLabel, setOrgLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [warehouseId, setWarehouseId] = useState(initialWarehouseId);
  const [cart, setCart] = useState<Map<string, number>>(() => new Map());
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedState | null>(null);
  const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>('delivery');
  const [phone, setPhone] = useState('');
  const [deliveryCharterId, setDeliveryCharterId] = useState<string>('');
  const [pickupNotes, setPickupNotes] = useState('');
  // I13: honeypot. A hidden field labeled "website" that real
  // submitters never see / fill, but naive form-bots will. The
  // server treats any non-empty value here as a bot signal and
  // silently 200s without persisting.
  const [hp, setHp] = useState('');

  // The book list itself is currently bound to the initial warehouse —
  // when the user changes warehouses, we reset the cart and let the
  // page reload via a client-side navigation. We keep that simple by
  // reloading on warehouse change rather than re-fetching books inline.
  const books = initialBooks;

  const lineCount = useMemo(
    () => Array.from(cart.values()).filter((q) => q > 0).length,
    [cart],
  );
  const totalQty = useMemo(
    () => Array.from(cart.values()).reduce((s, q) => s + q, 0),
    [cart],
  );

  function setQty(itemId: string, qty: number) {
    setCart((prev) => {
      const next = new Map(prev);
      if (qty <= 0) next.delete(itemId);
      else next.set(itemId, qty);
      return next;
    });
  }

  function bumpQty(itemId: string, delta: number) {
    const current = cart.get(itemId) ?? 0;
    setQty(itemId, Math.max(0, current + delta));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim() || !email.trim()) {
      toast.error('Add your name and email before submitting.');
      return;
    }
    if (lineCount === 0) {
      toast.error('Add at least one book to your request.');
      return;
    }
    if (fulfillmentType === 'delivery' && !deliveryCharterId) {
      toast.error('Pick a delivery site.');
      return;
    }

    const lines = Array.from(cart.entries())
      .filter(([, q]) => q > 0)
      .map(([itemId, q]) => ({ itemId, quantity: q }));

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/order-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          warehouseId,
          requesterName: name.trim(),
          requesterEmail: email.trim(),
          requesterOrgLabel: orgLabel.trim() || undefined,
          notes: notes.trim() || undefined,
          lines,
          fulfillmentType,
          requesterPhone: phone.trim() || null,
          deliveryCharterId:
            fulfillmentType === 'delivery' ? deliveryCharterId : null,
          pickupLocationNotes:
            fulfillmentType === 'pickup'
              ? pickupNotes.trim() || null
              : null,
          hp: hp || undefined,
        }),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          (json as { message?: string; error?: string }).message ??
          (json as { error?: string }).error ??
          'Something went wrong.';
        toast.error(message);
        return;
      }
      const ok = json as { id: string; trackUrl: string };
      setSubmitted({ id: ok.id, email: email.trim(), trackUrl: ok.trackUrl });
    } catch {
      toast.error("Couldn't reach the server. Check your network and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="border-border bg-card mt-2 rounded-2xl border p-6 text-center">
        <h2 className="font-display text-xl">Check your inbox</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          We&apos;ve emailed{' '}
          <span className="text-foreground font-medium">{submitted.email}</span>{' '}
          a link to confirm this order request. Once you click the link,
          {' '}{orgName}&apos;s team will review it — until then, the request
          stays on hold and is not visible to anyone else.
        </p>
        <p className="text-muted-foreground mt-3 text-xs">
          Didn&apos;t get it? Check your spam folder, or try again with a
          different email address. The confirmation link expires in 24 hours.
        </p>
        <p className="text-muted-foreground mt-4 text-xs">
          Request ID: <span className="font-mono">{submitted.id}</span>
        </p>
        <a
          // I15: the server already folds `&t=<token>` into trackUrl —
          // appending it client-side produced a double `&t=` query
          // parameter. Use trackUrl verbatim.
          href={submitted.trackUrl}
          className="mt-6 inline-block text-sm underline"
        >
          Track this order
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 pb-28">
      {/*
        I13: honeypot field. Rendered off-screen via `aria-hidden` +
        absolute positioning so real users (including screen-reader
        users) never see it. Tab-index is -1 so keyboard navigation
        skips it. `autoComplete="off"` discourages browser autofill
        from populating it. Empty submissions pass through; any
        non-empty value triggers the server-side silent-200.
      */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
      >
        <label htmlFor="por-hp">Website</label>
        <input
          type="text"
          id="por-hp"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(e) => setHp(e.target.value)}
        />
      </div>

      {/* Requester info */}
      <section className="space-y-4">
        <h2 className="font-display text-lg">Your info</h2>
        <div className="space-y-3">
          <div>
            <Label htmlFor="por-name">Name</Label>
            <Input
              id="por-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="por-email">Email</Label>
            <Input
              id="por-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              maxLength={254}
            />
          </div>
          <div>
            <Label htmlFor="por-org">
              School or organization
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="por-org"
              value={orgLabel}
              onChange={(e) => setOrgLabel(e.target.value)}
              autoComplete="organization"
              maxLength={160}
              placeholder="e.g. Lincoln Elementary"
            />
          </div>
        </div>
      </section>

      {/* Fulfillment type — pickup vs. delivery + contact / address details. */}
      <section className="border-border bg-card space-y-4 rounded-2xl border p-5">
        <h2 className="font-display text-lg">How should we get this to you?</h2>
        <div role="radiogroup" aria-label="Fulfillment type" className="flex gap-3">
          <button
            type="button"
            role="radio"
            aria-checked={fulfillmentType === 'pickup'}
            onClick={() => setFulfillmentType('pickup')}
            className={cn(
              'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
              fulfillmentType === 'pickup' && 'border-primary bg-primary/5',
            )}
          >
            <Package className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" aria-hidden />
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
            className={cn(
              'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
              fulfillmentType === 'delivery' && 'border-primary bg-primary/5',
            )}
          >
            <Truck className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div>
              <div className="font-medium">Delivery</div>
              <div className="text-muted-foreground mt-1 text-xs">
                Bring it to me.
              </div>
            </div>
          </button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="por-phone">
            Phone
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="por-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            autoComplete="tel"
            maxLength={40}
          />
        </div>

        {fulfillmentType === 'delivery' ? (
          <div className="space-y-3 rounded-xl bg-muted/40 p-4">
            <div className="space-y-2">
              <Label htmlFor="por-delivery-site">Deliver to which site?</Label>
              {chartersForWarehouse.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No delivery sites are configured for this warehouse yet. Ask the
                  warehouse to add some, or choose Pickup instead.
                </p>
              ) : (
                <Select
                  value={deliveryCharterId}
                  onValueChange={setDeliveryCharterId}
                >
                  <SelectTrigger id="por-delivery-site">
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
          <div className="space-y-2">
            <Label htmlFor="por-pickup-notes">
              Pickup notes
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="por-pickup-notes"
              value={pickupNotes}
              onChange={(e) => setPickupNotes(e.target.value)}
              placeholder="When you'll come by, who's picking up, etc."
              rows={2}
              maxLength={2000}
            />
          </div>
        )}
      </section>

      {/* Warehouse picker — only when more than one is eligible. */}
      {warehouses.length > 1 ? (
        <section className="space-y-2">
          <Label htmlFor="por-warehouse">Pickup location</Label>
          <Select
            value={warehouseId}
            onValueChange={(v) => {
              if (v === warehouseId) return;
              if (cart.size > 0) {
                if (!confirm('Switching locations will clear your cart. Continue?')) return;
              }
              setCart(new Map());
              setWarehouseId(v);
              // The book list is keyed off the initial warehouse on page load.
              // Reload the page so the server re-fetches its books.
              const params = new URLSearchParams(window.location.search);
              params.set('w', v);
              window.location.search = params.toString();
            }}
          >
            <SelectTrigger id="por-warehouse">
              <SelectValue placeholder="Pick a location" />
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      ) : null}

      {/* Book grid */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-lg">Books</h2>
          <span className="text-muted-foreground text-xs">
            {books.length} {books.length === 1 ? 'title' : 'titles'} available
          </span>
        </div>
        {books.length === 0 ? (
          <div className="border-border bg-card rounded-2xl border p-6 text-center">
            <p className="text-muted-foreground text-sm">
              No books are currently available at this location.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {books.map((b) => {
              const qty = cart.get(b.id) ?? 0;
              const inCart = qty > 0;
              return (
                <li
                  key={b.id}
                  className={cn(
                    'border-border bg-card flex gap-3 rounded-xl border p-3 transition-colors',
                    inCart && 'border-primary/40 bg-primary/5',
                  )}
                >
                  <div className="bg-muted relative h-16 w-12 flex-shrink-0 overflow-hidden rounded-md">
                    {b.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={b.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="flex flex-1 flex-col">
                    <p className="text-sm font-medium leading-snug">{b.name}</p>
                    {b.author ? (
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {b.author}
                      </p>
                    ) : null}
                    <div className="mt-auto flex items-center gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Decrease quantity of ${b.name}`}
                        disabled={qty === 0}
                        onClick={() => bumpQty(b.id, -1)}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="min-w-[2ch] text-center text-sm tabular-nums">
                        {qty}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Increase quantity of ${b.name}`}
                        onClick={() => bumpQty(b.id, 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Notes */}
      <section className="space-y-2">
        <Label htmlFor="por-notes">
          Notes
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="por-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          placeholder="Anything we should know — pickup timing, special needs, etc."
          rows={3}
        />
      </section>

      {/* Sticky submit */}
      <div className="bg-background/95 fixed inset-x-0 bottom-0 border-t backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2 text-sm">
            <ShoppingCart className="h-4 w-4" />
            <span className="text-muted-foreground">
              {lineCount} {lineCount === 1 ? 'title' : 'titles'} · {totalQty} books
            </span>
          </div>
          <Button type="submit" disabled={submitting || lineCount === 0} variant="gradient">
            {submitting ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      </div>
    </form>
  );
}
