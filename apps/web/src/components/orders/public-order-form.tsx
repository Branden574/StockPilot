'use client';

import { Minus, Plus, ShoppingCart } from 'lucide-react';
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

interface Props {
  token: string;
  orgName: string;
  warehouses: WarehouseSummary[];
  initialWarehouseId: string;
  initialBooks: BookSummary[];
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
}: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [orgLabel, setOrgLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [warehouseId, setWarehouseId] = useState(initialWarehouseId);
  const [cart, setCart] = useState<Map<string, number>>(() => new Map());
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedState | null>(null);

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
      toast.error('Please add your name and email.');
      return;
    }
    if (lineCount === 0) {
      toast.error('Add at least one book to your request.');
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
      toast.error('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="border-border bg-card mt-2 rounded-2xl border p-6 text-center">
        <h2 className="font-display text-xl">Request received</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          We&apos;ve emailed{' '}
          <span className="text-foreground font-medium">{submitted.email}</span>{' '}
          a confirmation. {orgName}&apos;s team will review your request shortly.
        </p>
        <p className="text-muted-foreground mt-4 text-xs">
          Request ID: <span className="font-mono">{submitted.id}</span>
        </p>
        <a
          href={`${submitted.trackUrl}&t=${encodeURIComponent(token)}`}
          className="mt-6 inline-block text-sm underline"
        >
          Track this order
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 pb-28">
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
            <Label htmlFor="por-org">School or organization (optional)</Label>
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
        <Label htmlFor="por-notes">Notes (optional)</Label>
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
          <Button type="submit" disabled={submitting || lineCount === 0}>
            {submitting ? 'Submitting…' : 'Submit request'}
          </Button>
        </div>
      </div>
    </form>
  );
}
