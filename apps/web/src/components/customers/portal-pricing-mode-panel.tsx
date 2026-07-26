'use client';

import { CircleDollarSign, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { setPortalPricingModeAction } from '@/server/actions/customers';

import type { PortalPricingMode } from '@stockpilot/core';

interface Option {
  value: PortalPricingMode;
  label: string;
  helper: string;
}

const OPTIONS: Option[] = [
  {
    value: 'no_charge',
    label: 'This organisation does not charge its customers',
    helper: 'The portal shows no prices and no order totals.',
  },
  {
    value: 'priced',
    label: 'Customers are charged from a price list',
    helper:
      "Each account's price list sets what it pays. Items with no price show a request-quote option.",
  },
];

/**
 * Per-org portal pricing mode (b2b_portal module's settings.pricingMode).
 * Absent/malformed settings resolve to `no_charge` on the read side
 * (resolvePortalPricingMode) — the safe direction — so this control is the
 * only way an org opts into showing real prices on its customer portal.
 */
export function PortalPricingModePanel({ initial }: { initial: PortalPricingMode }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<PortalPricingMode>(initial);
  const [busy, setBusy] = React.useState(false);
  const dirty = mode !== initial;

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const r = await setPortalPricingModeAction(mode);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Pricing mode saved.');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDollarSign className="h-4 w-4" /> Portal pricing
        </CardTitle>
        <CardDescription>
          Controls whether the customer portal shows prices and order totals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="border-input has-[:checked]:border-primary has-[:checked]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="radio"
                name="portal-pricing-mode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={() => setMode(opt.value)}
                disabled={busy}
                className="mt-1"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="text-muted-foreground block text-xs">{opt.helper}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={!dirty || busy} size="sm">
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
