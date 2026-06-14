import { notFound } from 'next/navigation';
import { Check, ExternalLink } from 'lucide-react';

import { BillingActions } from '@/components/billing/billing-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { BillingService } from '@/server/services/billing';
import { formatRelative } from '@/lib/utils';

import {
  hasPermission,
  isUnlimited,
  PLANS,
  resolveEffectivePlan,
  type OrgBillingState,
  type PlanId,
} from '@stockpilot/core';

export default async function BillingSettingsPage() {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'billing:read')) {
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

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">Plan, usage, and payment method.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Current plan
              <Badge variant={plan.highlight ? 'default' : 'secondary'}>{plan.name}</Badge>
              {arrangementLabel && <Badge variant="outline">{arrangementLabel}</Badge>}
            </CardTitle>
            <CardDescription>
              {isManaged ? 'Managed by StockPilot.' : plan.description}
            </CardDescription>
          </div>
          {org.trial_ends_at && (() => {
            const trialEndsAt = new Date(org.trial_ends_at as string);
            const trialExpired = trialEndsAt.getTime() < Date.now();
            return (
              <div className="text-right text-sm">
                <p className="text-xs text-muted-foreground">
                  {trialExpired ? 'Trial ended' : 'Trial ends'}
                </p>
                <p className={`font-medium ${trialExpired ? 'text-destructive' : ''}`}>
                  {formatRelative(org.trial_ends_at as string)}
                </p>
                {trialExpired && (
                  <p className="mt-1 text-xs text-destructive">
                    Subscribe to keep using paid features.
                  </p>
                )}
              </div>
            );
          })()}
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {plan.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <div className="rounded-md border bg-muted/30 p-4 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <UsageStat label="Items" max={plan.limits.items} />
              <UsageStat label="Members" max={plan.limits.members} />
              <UsageStat label="Locations" max={plan.limits.locations} />
            </div>
          </div>
          {isManaged ? (
            <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              Your plan is managed directly by StockPilot — there&apos;s nothing to pay or change
              here. Contact us if your needs change.
            </p>
          ) : (
            <BillingActions
              currentPlan={currentPlan}
              hasStripeCustomer={Boolean(org.stripe_customer_id)}
            />
          )}
        </CardContent>
      </Card>

      {!isManaged && (
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Other plans</CardTitle>
          <CardDescription>Upgrade or downgrade at any time. Pro-rated automatically.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(['pro', 'business', 'enterprise'] as const)
            .filter((p) => p !== currentPlan)
            .map((p) => {
              const def = PLANS[p];
              return (
                <div key={p} className="flex flex-col rounded-xl border p-4">
                  <p className="font-semibold">{def.name}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{def.description}</p>
                  <p className="mt-3 text-xl font-semibold tabular-nums">
                    {def.monthlyPrice < 0 ? 'Custom' : `$${def.monthlyPrice}/user/mo`}
                  </p>
                  {p === 'enterprise' ? (
                    <a
                      href="mailto:sales@stockpilotusa.com"
                      className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      Contact sales <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              );
            })}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function UsageStat({ label, max }: { label: string; max: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{isUnlimited(max) ? 'Unlimited' : max.toLocaleString()}</p>
    </div>
  );
}
