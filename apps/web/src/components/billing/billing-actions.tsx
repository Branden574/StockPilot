'use client';

import { ExternalLink, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createCheckoutSessionAction, createPortalSessionAction } from '@/server/actions/billing';

import type { PlanId } from '@stockpilot/core';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';

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
    let res: Awaited<ReturnType<typeof createCheckoutSessionAction>>;
    try {
      res = await createCheckoutSessionAction({ plan, interval });
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage('open checkout'));
      return;
    } finally {
      setLoading(null);
    }
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    window.location.href = res.data.url;
  }

  async function openPortal() {
    setLoading('portal');
    let res: Awaited<ReturnType<typeof createPortalSessionAction>>;
    try {
      res = await createPortalSessionAction();
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage('open the billing portal'));
      return;
    } finally {
      setLoading(null);
    }
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
          {loading === 'pro-monthly' ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Upgrade to Pro
        </Button>
        <Button
          variant="outline"
          onClick={() => startCheckout('business', 'monthly')}
          disabled={loading === 'business-monthly'}
        >
          {loading === 'business-monthly' ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Upgrade to Business
        </Button>
      </div>
    );
  }

  if (currentPlan === 'enterprise') {
    return (
      <p className="text-muted-foreground pt-1 text-[13px]">
        Enterprise billing is managed manually. Contact your account manager for changes.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {hasStripeCustomer && (
        <Button variant="default" onClick={openPortal} disabled={loading === 'portal'}>
          {loading === 'portal' ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Manage subscription
          {loading === 'portal' ? null : <ExternalLink aria-hidden className="h-3.5 w-3.5" />}
        </Button>
      )}
      {currentPlan === 'pro' && (
        <Button
          variant="outline"
          onClick={() => startCheckout('business', 'monthly')}
          disabled={loading === 'business-monthly'}
        >
          {loading === 'business-monthly' ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Upgrade to Business
        </Button>
      )}
    </div>
  );
}
