'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { DetailSection } from '@/components/patterns/detail-section';
import { PLATFORM_SELECT_CLASS } from '@/components/platform/platform-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { setOrgBillingAction, startOrgTrialAction } from '@/server/actions/platform/billing';

import type { PlanId } from '@stockpilot/core';

type Arrangement = 'standard' | 'comped' | 'trial' | 'custom' | 'stripe';
const PLAN_OPTIONS: PlanId[] = ['free', 'pro', 'business', 'enterprise'];

export interface BillingPanelProps {
  organizationId: string;
  accessTier: string | null;
  arrangement: string;
  customPriceCents: number | null;
  customPriceInterval: 'month' | 'year' | null;
  allModulesComp: boolean;
  billingNotes: string | null;
  trialTier: string | null;
  trialEndsAt: string | null;
  hasStripeSubscription: boolean;
  effectiveLabel: string;
  trialDaysRemaining: number | null;
}

function aal2(msg: { reason?: string } | undefined): boolean {
  return msg?.reason === 'aal2_required';
}

export function BillingPanel(props: BillingPanelProps) {
  const stepUp = useStepUp();
  const [accessTier, setAccessTier] = React.useState<string>(props.accessTier ?? '');
  const [arrangement, setArrangement] = React.useState<Arrangement>(
    (props.arrangement as Arrangement) ?? 'standard',
  );
  const [priceDollars, setPriceDollars] = React.useState<string>(
    props.customPriceCents != null ? (props.customPriceCents / 100).toFixed(2) : '',
  );
  const [priceInterval, setPriceInterval] = React.useState<'month' | 'year'>(
    props.customPriceInterval ?? 'month',
  );
  const [allModulesComp, setAllModulesComp] = React.useState(props.allModulesComp);
  const [notes, setNotes] = React.useState(props.billingNotes ?? '');
  const [saving, startSave] = React.useTransition();

  const [trialDays, setTrialDays] = React.useState('14');
  const [trialTier, setTrialTier] = React.useState<string>(props.trialTier ?? 'enterprise');
  const [trialing, startTrialTx] = React.useTransition();

  function onSave() {
    startSave(async () => {
      const payload = {
        organizationId: props.organizationId,
        accessTier: accessTier === '' ? null : (accessTier as PlanId),
        arrangement,
        customPriceCents:
          arrangement === 'custom' && priceDollars.trim() !== ''
            ? Math.round(parseFloat(priceDollars) * 100)
            : null,
        customPriceInterval: arrangement === 'custom' ? priceInterval : null,
        allModulesComp,
        billingNotes: notes.trim() === '' ? null : notes.trim(),
      };
      let res = await setOrgBillingAction(payload);
      // Fresh MFA step-up needed → prompt for the authenticator code in-place
      // (no sign-out) and retry with the identical payload.
      if (!res.ok && aal2(res.error.details)) {
        if (!(await stepUp.ensure())) return;
        res = await setOrgBillingAction(payload);
      }
      if (res.ok) toast.success('Billing updated.');
      else toast.error(res.error.message);
    });
  }

  function onStartTrial() {
    const days = parseInt(trialDays, 10);
    if (!Number.isFinite(days) || days < 1) {
      toast.error('Enter a valid number of trial days.');
      return;
    }
    if (!window.confirm(`Start a ${days}-day ${trialTier} trial for this org?`)) return;
    startTrialTx(async () => {
      const payload = {
        organizationId: props.organizationId,
        days,
        trialTier: trialTier as PlanId,
      };
      let res = await startOrgTrialAction(payload);
      // Fresh MFA step-up needed → prompt for the authenticator code in-place
      // (no sign-out) and retry with the identical payload.
      if (!res.ok && aal2(res.error.details)) {
        if (!(await stepUp.ensure())) return;
        res = await startOrgTrialAction(payload);
      }
      if (res.ok) toast.success(`${days}-day trial started.`);
      else toast.error(res.error.message);
    });
  }

  // Every label names its control (htmlFor + id); they used to sit beside
  // their fields with nothing tying the two together.
  const ids = {
    accessTier: `billing-access-tier-${props.organizationId}`,
    arrangement: `billing-arrangement-${props.organizationId}`,
    price: `billing-custom-price-${props.organizationId}`,
    interval: `billing-interval-${props.organizationId}`,
    notes: `billing-notes-${props.organizationId}`,
    trialDays: `trial-days-${props.organizationId}`,
    trialTier: `trial-tier-${props.organizationId}`,
  };

  return (
    <>
      {stepUp.modal}
      <div className="flex max-w-3xl flex-col gap-4">
        <div
          data-slot="billing-effective"
          className="border-border bg-card rounded-lg border px-[18px] py-3.5 text-[13px]"
        >
          Effective right now: <span className="font-semibold">{props.effectiveLabel}</span>
          {props.trialDaysRemaining != null ? (
            <span className="text-warning"> · {props.trialDaysRemaining}d trial left</span>
          ) : null}
          {props.hasStripeSubscription ? (
            <span className="text-muted-foreground"> · has a live Stripe subscription</span>
          ) : null}
        </div>

        {/* ── Override panel ───────────────────────────────────────────── */}
        <DetailSection
          title="Access & billing override"
          footer={
            <Button type="button" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save billing'}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-[13px]">
              A manual override wins over Stripe. &ldquo;Comped&rdquo; + Enterprise = full access,
              no charge. Leave access tier blank to defer to Stripe/default.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.accessTier}>Access tier</Label>
                <select
                  id={ids.accessTier}
                  value={accessTier}
                  onChange={(e) => setAccessTier(e.target.value)}
                  className={PLATFORM_SELECT_CLASS}
                >
                  <option value="">— no override (Stripe/default) —</option>
                  {PLAN_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                      {p === 'enterprise' ? ' (full access)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.arrangement}>Billing arrangement</Label>
                <select
                  id={ids.arrangement}
                  value={arrangement}
                  onChange={(e) => setArrangement(e.target.value as Arrangement)}
                  className={PLATFORM_SELECT_CLASS}
                >
                  <option value="standard">Standard</option>
                  <option value="comped">Comped (no charge)</option>
                  <option value="trial">Trial</option>
                  <option value="custom">Custom price</option>
                  <option value="stripe">Stripe</option>
                </select>
              </div>
            </div>

            {arrangement === 'custom' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.price}>Custom price (USD)</Label>
                  <Input
                    id={ids.price}
                    type="number"
                    min="0"
                    step="0.01"
                    value={priceDollars}
                    onChange={(e) => setPriceDollars(e.target.value)}
                    placeholder="45.00"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.interval}>Interval</Label>
                  <select
                    id={ids.interval}
                    value={priceInterval}
                    onChange={(e) => setPriceInterval(e.target.value as 'month' | 'year')}
                    className={PLATFORM_SELECT_CLASS}
                  >
                    <option value="month">per month</option>
                    <option value="year">per year</option>
                  </select>
                </div>
              </div>
            )}

            <Checkbox
              checked={allModulesComp}
              onCheckedChange={setAllModulesComp}
              className="self-start max-sm:min-h-11"
            >
              Unlock every premium module (full feature access)
            </Checkbox>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.notes}>Notes</Label>
              <Textarea
                id={ids.notes}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="e.g. investor pilot — convert in Aug; pays by invoice"
                className="min-h-0"
              />
            </div>
          </div>
        </DetailSection>

        {/* ── Trial starter ────────────────────────────────────────────── */}
        <DetailSection title="Start a trial">
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-[13px]">
              Stamps a fresh trial window and clears any tier override so the trial drives access.
              The days-remaining countdown shows everywhere.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.trialDays}>Days</Label>
                <Input
                  id={ids.trialDays}
                  type="number"
                  min="1"
                  max="365"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.trialTier}>Trial unlocks</Label>
                <select
                  id={ids.trialTier}
                  value={trialTier}
                  onChange={(e) => setTrialTier(e.target.value)}
                  className={PLATFORM_SELECT_CLASS}
                >
                  {PLAN_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onStartTrial}
                  disabled={trialing}
                  className="max-sm:h-11 max-sm:w-full"
                >
                  {trialing ? 'Starting…' : 'Start trial'}
                </Button>
              </div>
            </div>
          </div>
        </DetailSection>

        <p className="text-muted-foreground text-[12.5px]">
          Changing billing requires a fresh MFA step-up and is recorded in the platform audit log.
        </p>
      </div>
    </>
  );
}
