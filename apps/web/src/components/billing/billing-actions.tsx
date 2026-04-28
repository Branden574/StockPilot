'use client';

import { ExternalLink, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  createCheckoutSessionAction,
  createPortalSessionAction,
} from '@/server/actions/billing';

import type { PlanId } from '@stockpilot/core';

export function BillingActions({
  currentPlan,
  hasStripeCustomer,
}: {
  currentPlan: PlanId;
  hasStripeCustomer: boolean;
}) {
  const [loading, setLoading] = React.useState<string | null>(null);

  async function startCheckout(plan: 'pro' | 'business', interval: 'monthly' | 'yearly') {
    setLoading(`${plan}-${interval}`);
    const res = await createCheckoutSessionAction({ plan, interval });
    setLoading(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    window.location.href = res.data.url;
  }

  async function openPortal() {
    setLoading('portal');
    const res = await createPortalSessionAction();
    setLoading(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    window.location.href = res.data.url;
  }

  if (currentPlan === 'free') {
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          variant="gradient"
          onClick={() => startCheckout('pro', 'monthly')}
          disabled={loading === 'pro-monthly'}
        >
          {loading === 'pro-monthly' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upgrade to Pro'}
        </Button>
        <Button
          variant="outline"
          onClick={() => startCheckout('business', 'monthly')}
          disabled={loading === 'business-monthly'}
        >
          {loading === 'business-monthly' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Upgrade to Business'
          )}
        </Button>
      </div>
    );
  }

  if (currentPlan === 'enterprise') {
    return (
      <p className="pt-2 text-sm text-muted-foreground">
        Enterprise billing is managed manually. Contact your account manager for changes.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {hasStripeCustomer && (
        <Button variant="default" onClick={openPortal} disabled={loading === 'portal'}>
          {loading === 'portal' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              Manage subscription <ExternalLink className="h-3.5 w-3.5" />
            </>
          )}
        </Button>
      )}
      {currentPlan === 'pro' && (
        <Button
          variant="outline"
          onClick={() => startCheckout('business', 'monthly')}
          disabled={loading === 'business-monthly'}
        >
          {loading === 'business-monthly' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Upgrade to Business'
          )}
        </Button>
      )}
    </div>
  );
}
