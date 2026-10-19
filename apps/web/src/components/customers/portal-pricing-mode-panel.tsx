'use client';

import { CircleDollarSign, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
    <DetailSection
      title={
        <span className="inline-flex items-center gap-2">
          <CircleDollarSign aria-hidden className="text-muted-foreground h-4 w-4" /> Portal pricing
        </span>
      }
      footer={
        <>
          <span />
          <Button onClick={save} disabled={!dirty || busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground mb-3 text-[13px]">
        Controls whether the customer portal shows prices and order totals.
      </p>
      {/* Native radios under one name (the shared RadioGroup), so the arrow
          keys move between the two choices; Save stays disabled until the
          choice differs from the saved one. */}
      <RadioGroup
        name="portal-pricing-mode"
        aria-label="Portal pricing"
        variant="card"
        value={mode}
        onValueChange={(v) => setMode(v as PortalPricingMode)}
        disabled={busy}
      >
        {OPTIONS.map((opt) => (
          <RadioGroupItem
            key={opt.value}
            value={opt.value}
            label={opt.label}
            description={opt.helper}
          />
        ))}
      </RadioGroup>
    </DetailSection>
  );
}
