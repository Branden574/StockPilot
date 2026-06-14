'use client';

import * as React from 'react';
import { toast } from 'sonner';

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
      const res = await setOrgBillingAction({
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
      });
      if (res.ok) toast.success('Billing updated.');
      else if (aal2(res.error.details)) toast.error('Re-authenticate with MFA, then try again.');
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
      const res = await startOrgTrialAction({
        organizationId: props.organizationId,
        days,
        trialTier: trialTier as PlanId,
      });
      if (res.ok) toast.success(`${days}-day trial started.`);
      else if (aal2(res.error.details)) toast.error('Re-authenticate with MFA, then try again.');
      else toast.error(res.error.message);
    });
  }

  const labelCls = 'text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]';
  const inputCls =
    'h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-[var(--ed-line-strong)]';

  return (
    <div className="space-y-6">
      <div className="rounded-[10px] border border-border bg-card p-4">
        <div className="text-[12.5px]">
          Effective right now: <span className="font-semibold">{props.effectiveLabel}</span>
          {props.trialDaysRemaining != null ? (
            <span className="text-amber-600"> · {props.trialDaysRemaining}d trial left</span>
          ) : null}
          {props.hasStripeSubscription ? (
            <span className="text-[var(--ed-ink-4)]"> · has a live Stripe subscription</span>
          ) : null}
        </div>
      </div>

      {/* ── Override panel ───────────────────────────────────────────── */}
      <div className="space-y-4 rounded-[10px] border border-border p-4">
        <h3 className="font-display text-[15px] font-medium">Access &amp; billing override</h3>
        <p className="text-[12px] text-[var(--ed-ink-3)]">
          A manual override wins over Stripe. &ldquo;Comped&rdquo; + Enterprise = full access, no
          charge. Leave access tier blank to defer to Stripe/default.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className={labelCls}>Access tier</label>
            <select
              value={accessTier}
              onChange={(e) => setAccessTier(e.target.value)}
              className={inputCls}
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
          <div className="space-y-1">
            <label className={labelCls}>Billing arrangement</label>
            <select
              value={arrangement}
              onChange={(e) => setArrangement(e.target.value as Arrangement)}
              className={inputCls}
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
            <div className="space-y-1">
              <label className={labelCls}>Custom price (USD)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                placeholder="45.00"
                className={inputCls}
              />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Interval</label>
              <select
                value={priceInterval}
                onChange={(e) => setPriceInterval(e.target.value as 'month' | 'year')}
                className={inputCls}
              >
                <option value="month">per month</option>
                <option value="year">per year</option>
              </select>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={allModulesComp}
            onChange={(e) => setAllModulesComp(e.target.checked)}
          />
          Unlock every premium module (full feature access)
        </label>

        <div className="space-y-1">
          <label className={labelCls}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. investor pilot — convert in Aug; pays by invoice"
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-[var(--ed-line-strong)]"
          />
        </div>

        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save billing'}
        </button>
      </div>

      {/* ── Trial starter ────────────────────────────────────────────── */}
      <div className="space-y-4 rounded-[10px] border border-border p-4">
        <h3 className="font-display text-[15px] font-medium">Start a trial</h3>
        <p className="text-[12px] text-[var(--ed-ink-3)]">
          Stamps a fresh trial window and clears any tier override so the trial drives access. The
          days-remaining countdown shows everywhere.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label className={labelCls}>Days</label>
            <input
              type="number"
              min="1"
              max="365"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Trial unlocks</label>
            <select
              value={trialTier}
              onChange={(e) => setTrialTier(e.target.value)}
              className={inputCls}
            >
              {PLAN_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onStartTrial}
              disabled={trialing}
              className="h-9 rounded-md border border-border px-3 text-[13px] font-medium hover:border-[var(--ed-line-strong)] disabled:opacity-50"
            >
              {trialing ? 'Starting…' : 'Start trial'}
            </button>
          </div>
        </div>
      </div>

      <p className="text-[11.5px] text-[var(--ed-ink-4)]">
        Changing billing requires a fresh MFA step-up and is recorded in the platform audit log.
      </p>
    </div>
  );
}
