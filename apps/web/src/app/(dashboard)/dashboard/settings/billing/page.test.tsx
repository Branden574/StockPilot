import { cleanup, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions } from '@stockpilot/core';

/**
 * B92: Stripe's checkout sends the person back to this page with
 * ?status=success or ?status=cancelled (BillingService.createCheckoutSession).
 * The page took no searchParams, so it said nothing about the outcome. It now
 * says one plain line for each, and nothing for anything else.
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'owner',
    permissions: effectivePermissions('owner'),
  })),
}));
vi.mock('@/server/services/billing', () => ({
  BillingService: {
    forCurrentUser: vi.fn(async () => ({
      getOrgBilling: vi.fn(async () => ({
        plan: 'free',
        stripe_customer_id: null,
        billing_arrangement: null,
        access_tier: null,
        trial_ends_at: null,
      })),
    })),
  },
}));
vi.mock('@/components/billing/billing-actions', () => ({
  BillingActions: () => <button type="button">Upgrade</button>,
}));
vi.mock('@/components/settings/settings-nav', () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsPanel: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import BillingSettingsPage from './page';

const SUCCESS =
  'Checkout complete. Your plan shows here once Stripe confirms the payment; reload the page if it has not changed yet.';
const CANCELLED = 'Checkout cancelled. Nothing was charged, and your plan has not changed.';

async function open(status?: string | string[]) {
  render(
    await BillingSettingsPage({
      searchParams: Promise.resolve(status === undefined ? {} : { status }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Billing after a Stripe checkout (B92)', () => {
  it('says the checkout went through, in one line, when Stripe sends ?status=success', async () => {
    await open('success');
    expect(screen.getByRole('status')).toHaveTextContent(SUCCESS);
    expect(screen.queryByText(CANCELLED)).toBeNull();
  });

  it('says the checkout was cancelled and nothing changed for ?status=cancelled', async () => {
    await open('cancelled');
    expect(screen.getByRole('status')).toHaveTextContent(CANCELLED);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it('says nothing with no status, an unknown one, or a repeated one', async () => {
    for (const status of [undefined, 'paid', ['success', 'cancelled']]) {
      cleanup();
      await open(status);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeInTheDocument();
    }
  });
});
