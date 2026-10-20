'use client';

import { ExternalLink, FileDown, Loader2, PackagePlus, Truck } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, formatCurrency } from '@/lib/utils';

/** Mirrors `ShippingRate` from the ShippingService (rate is a $ string). */
interface ShippingRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days: number | null;
}

/** Mirrors `CarrierShipmentRow` as the GET endpoint returns it. */
interface CarrierShipment {
  id: string;
  carrier: string | null;
  service: string | null;
  rate_cents: number | null;
  currency: string | null;
  tracking_code: string | null;
  tracking_status: string | null;
  tracking_url: string | null;
  label_url: string | null;
  status: 'draft' | 'purchased' | 'in_transit' | 'delivered' | 'returned' | 'failure' | 'cancelled';
}

interface RatesResponse {
  shipmentId: string;
  easypostShipmentId: string;
  rates: ShippingRate[];
}

interface Props {
  orderId: string;
  /**
   * True only for delivery orders at/after `staged_for_delivery` AND when the
   * viewer can manage shipping (owner/admin with the `shipping` module on). The
   * page resolves this; when false the buy affordance is hidden and only the
   * read-only tracking section can appear (if a shipment already exists).
   */
  canBuyLabel: boolean;
  /** Link to the charter settings page so a manager can add a mailing address. */
  charterSettingsHref: string;
}

/** The label's state on the six badge tones (DESIGN-SPEC 6.10); the words
 *  stay the status itself. */
const TRACKING_BADGE: Record<CarrierShipment['status'], NonNullable<BadgeProps['variant']>> = {
  draft: 'outline',
  purchased: 'secondary',
  in_transit: 'warning',
  delivered: 'success',
  returned: 'warning',
  failure: 'destructive',
  cancelled: 'outline',
};

function statusLabel(s: CarrierShipment['status']): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function ShippingPanel({ orderId, canBuyLabel, charterSettingsHref }: Props) {
  const [shipment, setShipment] = React.useState<CarrierShipment | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Editable parcel defaults — a small parcel a delivery order typically ships.
  const [weightOz, setWeightOz] = React.useState('16');
  const [lengthIn, setLengthIn] = React.useState('10');
  const [widthIn, setWidthIn] = React.useState('8');
  const [heightIn, setHeightIn] = React.useState('4');

  const [rates, setRates] = React.useState<ShippingRate[] | null>(null);
  const [selectedRateId, setSelectedRateId] = React.useState<string | null>(null);
  const [fetchingRates, setFetchingRates] = React.useState(false);
  const [buying, setBuying] = React.useState(false);
  // Set when rates fail because the destination charter has no mailing address;
  // we surface a direct link to fix it rather than the raw error.
  const [needsAddress, setNeedsAddress] = React.useState(false);

  const loadShipment = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/shipping`);
      if (!res.ok) {
        // Module off / forbidden / no shipment — render nothing.
        setShipment(null);
        return;
      }
      const data = (await res.json()) as { shipment: CarrierShipment | null };
      setShipment(data.shipment ?? null);
    } catch {
      setShipment(null);
    } finally {
      setLoaded(true);
    }
  }, [orderId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle: the state is set after the GET answers, never synchronously
    void loadShipment();
  }, [loadShipment]);

  function resetDialog() {
    setRates(null);
    setSelectedRateId(null);
    setNeedsAddress(false);
    setFetchingRates(false);
    setBuying(false);
  }

  async function fetchRates() {
    const parcel = {
      weight_oz: Number(weightOz),
      length_in: Number(lengthIn),
      width_in: Number(widthIn),
      height_in: Number(heightIn),
    };
    if (
      !Number.isFinite(parcel.weight_oz) ||
      parcel.weight_oz <= 0 ||
      !Number.isFinite(parcel.length_in) ||
      parcel.length_in <= 0 ||
      !Number.isFinite(parcel.width_in) ||
      parcel.width_in <= 0 ||
      !Number.isFinite(parcel.height_in) ||
      parcel.height_in <= 0
    ) {
      toast.error('Enter a positive weight and dimensions.');
      return;
    }

    setFetchingRates(true);
    setNeedsAddress(false);
    setRates(null);
    setSelectedRateId(null);
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/shipping/rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcel }),
      });
      const data = (await res.json().catch(() => null)) as
        (RatesResponse & { error?: string; message?: string }) | null;
      if (!res.ok) {
        const message = data?.message ?? 'Could not fetch rates.';
        // The service raises validation_error with this exact message when the
        // destination charter has no mailing address — show the fix-it link.
        if (res.status === 400 && /charter has no mailing address/i.test(message)) {
          setNeedsAddress(true);
        } else {
          toast.error(message);
        }
        return;
      }
      const fetched = data?.rates ?? [];
      if (fetched.length === 0) {
        toast.error('No rates returned for this parcel.');
      }
      setRates(fetched);
    } catch {
      toast.error('Could not fetch rates.');
    } finally {
      setFetchingRates(false);
    }
  }

  async function buyLabel() {
    if (!selectedRateId) {
      toast.error('Select a rate first.');
      return;
    }
    setBuying(true);
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/shipping/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateId: selectedRateId }),
      });
      const data = (await res.json().catch(() => null)) as {
        shipment?: CarrierShipment;
        error?: string;
        message?: string;
      } | null;
      if (!res.ok || !data?.shipment) {
        toast.error(data?.message ?? 'Could not buy the label.');
        return;
      }
      setShipment(data.shipment);
      toast.success('Label purchased.');
      setDialogOpen(false);
      resetDialog();
    } catch {
      toast.error('Could not buy the label.');
    } finally {
      setBuying(false);
    }
  }

  // A purchased/tracked shipment to display read-only.
  const purchased = shipment && shipment.status !== 'draft' ? shipment : null;

  // Nothing to show: no buy affordance and no shipment. Avoid rendering an
  // empty card (also covers the module-off / forbidden cases where the GET
  // returned null).
  if (!loaded) return null;
  if (!canBuyLabel && !purchased) return null;

  return (
    <DetailSection
      title="Shipping"
      aside={<DetailSectionMeta>Carrier label &amp; tracking for this delivery.</DetailSectionMeta>}
      flush
    >
      {canBuyLabel && !purchased && (
        <div className="border-border flex justify-end border-b px-[18px] py-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetDialog();
              setDialogOpen(true);
            }}
          >
            <PackagePlus className="h-3.5 w-3.5" />
            Buy shipping label
          </Button>
        </div>
      )}

      <div>
        {purchased ? (
          <KeyValueList>
            <KeyValueRow label="Status">
              <Badge variant={TRACKING_BADGE[purchased.status]}>
                {statusLabel(purchased.status)}
              </Badge>
            </KeyValueRow>
            <KeyValueRow label="Carrier">
              {purchased.carrier ?? '—'}
              {purchased.service ? (
                <span className="text-muted-foreground"> · {purchased.service}</span>
              ) : null}
            </KeyValueRow>
            <KeyValueRow label="Tracking #" valueClassName="font-mono text-[12.5px]">
              {purchased.tracking_url && purchased.tracking_code ? (
                <a
                  href={purchased.tracking_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {purchased.tracking_code}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                (purchased.tracking_code ?? '—')
              )}
            </KeyValueRow>
            {purchased.tracking_status && (
              <KeyValueRow label="Carrier status" valueClassName="capitalize">
                {purchased.tracking_status.replace(/_/g, ' ')}
              </KeyValueRow>
            )}
            {purchased.rate_cents != null && (
              <KeyValueRow label="Cost">
                {formatCurrency(purchased.rate_cents / 100, purchased.currency ?? 'USD')}
              </KeyValueRow>
            )}
          </KeyValueList>
        ) : (
          <p className="text-muted-foreground px-[18px] py-3.5 text-[13px]">
            No shipping label yet. Buy a label to generate tracking for this delivery.
          </p>
        )}
        {purchased?.label_url && (
          <div className="border-border border-t px-[18px] py-3">
            <Button variant="outline" size="sm" asChild>
              <a href={purchased.label_url} target="_blank" rel="noopener noreferrer">
                <FileDown className="h-3.5 w-3.5" />
                Download label
              </a>
            </Button>
          </div>
        )}
      </div>

      {/* Buy-label dialog: enter parcel → fetch rates → pick → buy. */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(v) => {
          if (fetchingRates || buying) return;
          setDialogOpen(v);
          if (!v) resetDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Buy shipping label</DialogTitle>
            <DialogDescription>
              Enter the parcel size, fetch carrier rates, then confirm a rate to buy a label. Buying
              postage charges your EasyPost account.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="ship-weight">Weight (oz)</Label>
                <Input
                  id="ship-weight"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={weightOz}
                  onChange={(e) => setWeightOz(e.target.value)}
                  disabled={fetchingRates || buying}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ship-length">Length (in)</Label>
                <Input
                  id="ship-length"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={lengthIn}
                  onChange={(e) => setLengthIn(e.target.value)}
                  disabled={fetchingRates || buying}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ship-width">Width (in)</Label>
                <Input
                  id="ship-width"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={widthIn}
                  onChange={(e) => setWidthIn(e.target.value)}
                  disabled={fetchingRates || buying}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ship-height">Height (in)</Label>
                <Input
                  id="ship-height"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={heightIn}
                  onChange={(e) => setHeightIn(e.target.value)}
                  disabled={fetchingRates || buying}
                />
              </div>
            </div>

            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchRates}
                disabled={fetchingRates || buying}
              >
                {fetchingRates ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Truck className="h-3.5 w-3.5" />
                )}
                {rates ? 'Refresh rates' : 'Get rates'}
              </Button>
            </div>

            {needsAddress && (
              <div
                className="border-destructive/30 bg-destructive-wash rounded-lg border p-3 text-[12.5px]"
                role="alert"
              >
                <p className="text-destructive font-medium">This charter has no mailing address.</p>
                <p className="text-muted-foreground mt-1">
                  Add a mailing address to this charter first.{' '}
                  <a href={charterSettingsHref} className="text-foreground underline">
                    Open charter settings
                  </a>
                </p>
              </div>
            )}

            {rates && rates.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-[12.5px]">Select a rate to buy:</p>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {rates.map((r) => {
                    const selected = selectedRateId === r.id;
                    const price = Number(r.rate);
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedRateId(r.id)}
                          disabled={buying}
                          aria-pressed={selected}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-[13px] transition-colors',
                            selected
                              ? 'border-accent bg-success-wash ring-accent ring-1'
                              : 'border-border hover:bg-muted',
                          )}
                        >
                          <span>
                            <span className="font-medium">{r.carrier}</span>
                            <span className="text-muted-foreground"> · {r.service}</span>
                            {r.delivery_days != null && (
                              <span className="text-muted-foreground block text-[12px]">
                                {r.delivery_days} day
                                {r.delivery_days === 1 ? '' : 's'} in transit
                              </span>
                            )}
                          </span>
                          <span className="font-medium tabular-nums">
                            {Number.isFinite(price)
                              ? formatCurrency(price, r.currency || 'USD')
                              : `${r.rate} ${r.currency}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                resetDialog();
              }}
              disabled={fetchingRates || buying}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={buyLabel}
              disabled={!selectedRateId || fetchingRates || buying}
            >
              {buying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Buy label
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailSection>
  );
}
