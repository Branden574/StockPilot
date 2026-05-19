'use client';

import { Package, Truck, UserCircle2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { isManagerOrAbove } from '@stockpilot/core';

import { useCart } from './cart-context';

interface SetupStripProps {
  warehouses: Array<{ id: string; name: string }>;
  warehouseId: string;
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
  viewerRole: string;
}

export function SetupStrip({
  warehouses,
  warehouseId,
  chartersForWarehouse,
  viewerRole,
}: SetupStripProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, dispatch } = useCart();
  const [onBehalfOfOpen, setOnBehalfOfOpen] = React.useState(false);
  const [pendingName, setPendingName] = React.useState(state.onBehalfOf?.name ?? '');
  const [pendingEmail, setPendingEmail] = React.useState(state.onBehalfOf?.email ?? '');

  const canActOnBehalf = isManagerOrAbove(viewerRole as Parameters<typeof isManagerOrAbove>[0]);

  function handleWarehouseChange(nextId: string) {
    if (nextId === warehouseId) return;
    if (state.lines.length > 0) {
      const ok = window.confirm('Switch warehouse? Your current cart will be cleared.');
      if (!ok) return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('warehouseId', nextId);
    // The page server-renders the new item list on navigation
    router.push(`/dashboard/orders/new?${params.toString()}`);
  }

  function handleFulfillmentChange(type: 'pickup' | 'delivery') {
    dispatch({ type: 'set-setup', patch: { fulfillmentType: type } });
    // When switching to pickup, clear the charter
    if (type === 'pickup') {
      dispatch({ type: 'set-setup', patch: { charterId: null } });
    }
  }

  function handleCharterChange(charterId: string) {
    dispatch({ type: 'set-setup', patch: { charterId } });
  }

  function handleOnBehalfOfSave() {
    if (!pendingName.trim() || !pendingEmail.trim()) return;
    dispatch({
      type: 'set-setup',
      patch: { onBehalfOf: { name: pendingName.trim(), email: pendingEmail.trim() } },
    });
    setOnBehalfOfOpen(false);
  }

  function handleOnBehalfOfClear() {
    dispatch({ type: 'set-setup', patch: { onBehalfOf: null } });
    setPendingName('');
    setPendingEmail('');
    setOnBehalfOfOpen(false);
  }

  const onBehalfLabel = state.onBehalfOf
    ? `For ${state.onBehalfOf.name}`
    : 'Requesting for…';

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
      {/* Warehouse selector */}
      <div className="space-y-1 min-w-[160px]">
        <Label className="text-xs">Warehouse</Label>
        <Select value={warehouseId} onValueChange={handleWarehouseChange}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Select warehouse" />
          </SelectTrigger>
          <SelectContent>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id} className="text-xs">
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* On behalf of (manager+ only) */}
      {canActOnBehalf && (
        <div className="space-y-1">
          <Label className="text-xs">Requester</Label>
          <Button
            type="button"
            variant={state.onBehalfOf ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              setPendingName(state.onBehalfOf?.name ?? '');
              setPendingEmail(state.onBehalfOf?.email ?? '');
              setOnBehalfOfOpen(true);
            }}
          >
            <UserCircle2 className="h-3.5 w-3.5" />
            {onBehalfLabel}
          </Button>
        </div>
      )}

      {/* Deliver-to site */}
      <div className="space-y-1 min-w-[160px]">
        <Label className="text-xs">Deliver to</Label>
        <Select
          value={state.charterId ?? ''}
          onValueChange={handleCharterChange}
          disabled={state.fulfillmentType === 'pickup'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={state.fulfillmentType === 'pickup' ? 'N/A (Pickup)' : 'Select site'} />
          </SelectTrigger>
          <SelectContent>
            {chartersForWarehouse.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.name}
                {c.code ? ` (${c.code})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Pickup / Delivery toggle */}
      <div className="space-y-1">
        <Label className="text-xs">How</Label>
        <div role="radiogroup" aria-label="Fulfillment type" className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={state.fulfillmentType === 'pickup' ? 'default' : 'outline'}
            onClick={() => handleFulfillmentChange('pickup')}
            className={cn('h-8 gap-1.5 text-xs', state.fulfillmentType === 'pickup' && '')}
            aria-pressed={state.fulfillmentType === 'pickup'}
          >
            <Package className="h-3.5 w-3.5" />
            Pickup
          </Button>
          <Button
            type="button"
            size="sm"
            variant={state.fulfillmentType === 'delivery' ? 'default' : 'outline'}
            onClick={() => handleFulfillmentChange('delivery')}
            className="h-8 gap-1.5 text-xs"
            aria-pressed={state.fulfillmentType === 'delivery'}
          >
            <Truck className="h-3.5 w-3.5" />
            Delivery
          </Button>
        </div>
      </div>

      {/* On-behalf-of Dialog */}
      <Dialog open={onBehalfOfOpen} onOpenChange={setOnBehalfOfOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Order on behalf of</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="obo-name">Their name</Label>
              <Input
                id="obo-name"
                value={pendingName}
                onChange={(e) => setPendingName(e.target.value)}
                placeholder="Jane Smith"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="obo-email">Their email</Label>
              <Input
                id="obo-email"
                type="email"
                value={pendingEmail}
                onChange={(e) => setPendingEmail(e.target.value)}
                placeholder="jane@example.com"
                maxLength={254}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The order will be tracked against this requester&apos;s email, and they&apos;ll receive
              the same status emails as a direct submitter.
            </p>
            <div className="flex gap-2 justify-end">
              {state.onBehalfOf && (
                <Button variant="ghost" size="sm" onClick={handleOnBehalfOfClear}>
                  Remove
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setOnBehalfOfOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleOnBehalfOfSave}
                disabled={!pendingName.trim() || !pendingEmail.trim()}
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
