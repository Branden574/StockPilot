import { notFound } from 'next/navigation';
import { Check, ExternalLink } from 'lucide-react';

import { BillingActions } from '@/components/billing/billing-actions';
import { PageHeader } from '@/components/patterns/page-header';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { Badge } from '@/components/ui/badge';
import { requireOrgContext } from '@/lib/auth/session';
import { BillingService } from '@/server/services/billing';
import { formatRelative } from '@/lib/utils';

import {
  can,
  isUnlimited,
  PLANS,
  resolveEffectivePlan,
  type OrgBillingState,
  type PlanId,
} from '@stockpilot/core';

export default async function BillingSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'billing:read')) {
    notFound();
  }
  const svc = await BillingService.forCurrentUser();
  const org = await svc.getOrgBilling();

  // Resolve the EFFECTIVE plan (admin override > Stripe > trial > free), so a
  // Comped/Enterprise org sees its real plan here — not the raw `plan` column.
  const effective = resolveEffectivePlan(org as OrgBillingState);
  const currentPlan: PlanId = effective.tier;
  const plan = PLANS[currentPlan];
  const arrangement = org.billing_arrangement as string | null;
  // "Managed by StockPilot": a manual admin override (comped/custom/forced
  // tier) is in effect — self-serve checkout would conflict with it, so we
  // show the managed state instead of upgrade buttons.
  const isManaged =
    Boolean(org.access_tier) || arrangement === 'comped' || arrangement === 'custom';
  const arrangementLabel =
    arrangement === 'comped'
      ? 'Complimentary — no charge'
      : arrangement === 'custom'
        ? 'Custom pricing'
        : null;

  const trialEndsAt = org.trial_ends_at ? new Date(org.trial_ends_at as string) : null;
  const trialExpired = trialEndsAt !== null && trialEndsAt.getTime() < Date.now();

  return (
    <SettingsPage>
      <PageHeader title="Billing" subline="Plan, usage, and payment method." />

      <SettingsPanel
        title={
          <span className="flex flex-wrap items-center gap-2">
            Current plan
            <Badge variant={plan.highlight ? 'default' : 'secondary'}>{plan.name}</Badge>
            {arrangementLabel && <Badge variant="outline">{arrangementLabel}</Badge>}
          </span>
        }
        description={isManaged ? 'Managed by StockPilot.' : plan.description}
        aside={
          trialEndsAt ? (
            <div className="text-right text-[13px]">
              <p className="text-muted-foreground text-[12px]">
                {trialExpired ? 'Trial ended' : 'Trial ends'}
              </p>
              <p className={trialExpired ? 'text-destructive font-medium' : 'font-medium'}>
                {formatRelative(org.trial_ends_at as string)}
              </p>
              {trialExpired && (
                <p className="text-destructive mt-1 text-[12px]">
                  Subscribe to keep using paid features.
                </p>
              )}
            </div>
          ) : null
        }
        bodyClassName="space-y-4"
      >
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[13px]">
              <Check aria-hidden className="text-success mt-0.5 h-4 w-4 shrink-0" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div className="bg-sunk rounded-lg border px-4 py-3">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <UsageStat label="Items" max={plan.limits.items} />
            <UsageStat label="Members" max={plan.limits.members} />
            <UsageStat label="Locations" max={plan.limits.locations} />
          </div>
        </div>
        {isManaged ? (
          <p className="bg-sunk text-muted-foreground rounded-lg border px-4 py-3 text-[13px]">
            Your plan is managed directly by StockPilot — there&apos;s nothing to pay or change
            here. Contact us if your needs change.
          </p>
        ) : (
          <BillingActions
            currentPlan={currentPlan}
            hasStripeCustomer={Boolean(org.stripe_customer_id)}
          />
        )}
      </SettingsPanel>

      {!isManaged && (
        <SettingsPanel
          title="Other plans"
          description="Upgrade or downgrade at any time. Pro-rated automatically."
          bodyClassName="grid gap-3 sm:grid-cols-2"
        >
          {(['pro', 'business', 'enterprise'] as const)
            .filter((p) => p !== currentPlan)
            .map((p) => {
              const def = PLANS[p];
              return (
                <div key={p} className="flex flex-col rounded-lg border p-4">
                  <p className="text-[13.5px] font-medium">{def.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-[12.5px]">{def.description}</p>
                  <p className="mt-3 font-display text-[20px] font-medium tabular-nums tracking-[-0.02em]">
                    {def.monthlyPrice < 0 ? 'Custom' : `$${def.monthlyPrice}/user/mo`}
                  </p>
                  {p === 'enterprise' ? (
                    <a
                      href="mailto:sales@stockpilotusa.com"
                      className="text-accent hover:text-foreground mt-3 inline-flex items-center gap-1 text-[13px] hover:underline"
                    >
                      Contact sales <ExternalLink aria-hidden className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              );
            })}
        </SettingsPanel>
      )}
    </SettingsPage>
  );
}

function UsageStat({ label, max }: { label: string; max: number }) {
  return (
    <div>
      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
        {label}
      </p>
      <p className="text-[13.5px] font-medium tabular-nums">
        {isUnlimited(max) ? 'Unlimited' : max.toLocaleString()}
      </p>
    </div>
  );
}
