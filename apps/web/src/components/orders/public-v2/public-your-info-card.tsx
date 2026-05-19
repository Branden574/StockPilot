'use client';

import { Package, Truck } from 'lucide-react';
import * as React from 'react';

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

import { useCart } from '@/components/orders/v2/cart-context';

interface PublicYourInfoCardProps {
  name: string;
  onNameChange: (v: string) => void;
  email: string;
  onEmailChange: (v: string) => void;
  orgLabel: string;
  onOrgLabelChange: (v: string) => void;
  phone: string;
  onPhoneChange: (v: string) => void;
  pickupNotes: string;
  onPickupNotesChange: (v: string) => void;
  hp: string;
  onHpChange: (v: string) => void;
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
}

/**
 * "Your info" card shown above the aisle bar on the public order link page.
 * Collects requester name, email, org, phone, fulfillment type, and the
 * relevant delivery/pickup sub-fields. Fulfillment type and delivery charter
 * are stored in CartState so the CartRail can read them at submit time.
 * The off-screen honeypot anti-bot field is also rendered here.
 */
export function PublicYourInfoCard({
  name,
  onNameChange,
  email,
  onEmailChange,
  orgLabel,
  onOrgLabelChange,
  phone,
  onPhoneChange,
  pickupNotes,
  onPickupNotesChange,
  hp,
  onHpChange,
  chartersForWarehouse,
}: PublicYourInfoCardProps) {
  const { state, dispatch } = useCart();
  const fulfillmentType = state.fulfillmentType;

  function setFulfillmentType(t: 'pickup' | 'delivery') {
    dispatch({ type: 'set-setup', patch: { fulfillmentType: t } });
  }

  function setDeliveryCharterId(id: string) {
    dispatch({ type: 'set-setup', patch: { charterId: id } });
  }

  return (
    <div className="rounded-2xl border bg-card p-5 space-y-5">
      {/* Honeypot — rendered off-screen, never visible to real users */}
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
        <label htmlFor="pub-v2-hp">Website</label>
        <input
          type="text"
          id="pub-v2-hp"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(e) => onHpChange(e.target.value)}
        />
      </div>

      <h2 className="font-display text-base font-semibold">Your info</h2>

      {/* Name + Email row on wider screens */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pub-v2-name">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="pub-v2-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            autoComplete="name"
            maxLength={120}
            placeholder="Your full name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pub-v2-email">
            Email <span className="text-destructive">*</span>
          </Label>
          <Input
            id="pub-v2-email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            autoComplete="email"
            maxLength={254}
            placeholder="you@example.com"
          />
        </div>
      </div>

      {/* Org + Phone row */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pub-v2-org">
            School or organization
            <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="pub-v2-org"
            value={orgLabel}
            onChange={(e) => onOrgLabelChange(e.target.value)}
            autoComplete="organization"
            maxLength={160}
            placeholder="e.g. Lincoln Elementary"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pub-v2-phone">
            Phone
            <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="pub-v2-phone"
            type="tel"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder="(555) 123-4567"
            autoComplete="tel"
            maxLength={40}
          />
        </div>
      </div>

      {/* Fulfillment type */}
      <div className="space-y-3">
        <Label>How should we get this to you?</Label>
        <div role="radiogroup" aria-label="Fulfillment type" className="flex gap-3">
          <button
            type="button"
            role="radio"
            aria-checked={fulfillmentType === 'pickup'}
            onClick={() => setFulfillmentType('pickup')}
            className={cn(
              'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
              fulfillmentType === 'pickup' && 'border-primary bg-primary/5',
            )}
          >
            <Package
              className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium">Pickup</div>
              <div className="text-muted-foreground mt-0.5 text-xs">
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
              'border-border focus-visible:ring-ring flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
              fulfillmentType === 'delivery' && 'border-primary bg-primary/5',
            )}
          >
            <Truck
              className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium">Delivery</div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                Bring it to me.
              </div>
            </div>
          </button>
        </div>

        {/* Delivery sub-panel */}
        {fulfillmentType === 'delivery' && (
          <div className="rounded-xl bg-muted/40 p-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pub-v2-delivery-site">Deliver to which site?</Label>
              {chartersForWarehouse.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No delivery sites are configured for this warehouse yet. Ask the
                  warehouse to add some, or choose Pickup instead.
                </p>
              ) : (
                <Select
                  value={state.charterId ?? ''}
                  onValueChange={setDeliveryCharterId}
                >
                  <SelectTrigger id="pub-v2-delivery-site">
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
                We&apos;ll bring the order to this site. Your name, email, and
                phone above are how we&apos;ll reach you about the delivery.
              </p>
            </div>
          </div>
        )}

        {/* Pickup sub-panel */}
        {fulfillmentType === 'pickup' && (
          <div className="space-y-1.5">
            <Label htmlFor="pub-v2-pickup-notes">
              Pickup notes
              <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="pub-v2-pickup-notes"
              value={pickupNotes}
              onChange={(e) => onPickupNotesChange(e.target.value)}
              placeholder="When you'll come by, who's picking up, etc."
              rows={2}
              maxLength={2000}
              className="resize-none text-sm"
            />
          </div>
        )}
      </div>
    </div>
  );
}
