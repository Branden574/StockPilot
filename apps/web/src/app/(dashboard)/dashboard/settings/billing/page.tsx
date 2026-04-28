import { Check, ExternalLink } from 'lucide-react';

import { BillingActions } from '@/components/billing/billing-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BillingService } from '@/server/services/billing';
import { formatRelative } from '@/lib/utils';

import { isUnlimited, PLANS, type PlanId } from '@stockpilot/core';

export default async function BillingSettingsPage() {
  const svc = await BillingService.forCurrentUser();
  const org = await svc.getOrgBilling();

  const currentPlan = (org.plan as PlanId) ?? 'free';
  const plan = PLANS[currentPlan];

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">Plan, usage, and payment method.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              Current plan
              <Badge variant={plan.highlight ? 'default' : 'secondary'}>{plan.name}</Badge>
            </CardTitle>
            <CardDescription>{plan.description}</CardDescription>
          </div>
          {org.trial_ends_at && (
            <div className="text-right text-sm">
              <p className="text-xs text-muted-foreground">Trial ends</p>
              <p className="font-medium">{formatRelative(org.trial_ends_at as string)}</p>
            </div>
          )}
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
          <BillingActions
            currentPlan={currentPlan}
            hasStripeCustomer={Boolean(org.stripe_customer_id)}
          />
        </CardContent>
      </Card>

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
                      href="mailto:sales@stockpilot.app"
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
