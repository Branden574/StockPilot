import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, makeServiceContext } from '@/test/supabase-mock';

/**
 * BILLING ON A SERVER WITHOUT ITS STRIPE SETTINGS SAYS "NOT SET UP" (S31).
 *
 * Subscribe answered "Stripe price ID not configured for pro/monthly. Set
 * NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY in .env.local." when a price was
 * missing, and getStripe()'s "STRIPE_SECRET_KEY is not configured" reached
 * the billing action when the key was. A Server Action's result reaches the
 * browser as it is: the person now reads "This feature is not set up yet."
 * and the report names the setting.
 */

const h = vi.hoisted(() => ({
  env: {
    STRIPE_SECRET_KEY: '' as string | undefined,
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  },
  getStripe: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/stripe/server', () => ({ getStripe: h.getStripe }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { reportError } from '@/lib/error-reporter';

import { BillingService } from './billing';
import { ServiceError } from './context';

const NOT_SET_UP = 'This feature is not set up yet.';

function service() {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: { role: 'owner' }, error: null },
    'organizations.select': {
      data: { id: 'org-test', name: 'Example Org', stripe_customer_id: 'cus_example' },
      error: null,
    },
  });
  return new BillingService(makeServiceContext(stub.client, { role: 'owner' }));
}

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    return e as ServiceError;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.STRIPE_SECRET_KEY = 'configured';
  vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY', 'price_placeholder');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BillingService without its Stripe settings (S31)', () => {
  it('a missing price: not set up, never the setting or the file, reported as a warning', async () => {
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY', '');
    const e = await refusal(service().createCheckoutSession('pro', 'monthly'));
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'validation_error', message: NOT_SET_UP });
    expect(e.message).not.toMatch(/STRIPE|env/);
    expect(h.getStripe).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toContain('NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY');
    expect(context).toEqual({
      tag: 'billing.not_set_up',
      organizationId: 'org-test',
      level: 'warning',
    });
  });

  it('a missing secret key: Subscribe says not set up and never makes the Stripe client', async () => {
    h.env.STRIPE_SECRET_KEY = '';
    const e = await refusal(service().createCheckoutSession('pro', 'monthly'));
    expect(e).toMatchObject({ code: 'validation_error', message: NOT_SET_UP });
    expect(h.getStripe).not.toHaveBeenCalled();
    expect((vi.mocked(reportError).mock.calls[0]![0] as Error).message).toContain(
      'STRIPE_SECRET_KEY',
    );
  });

  it('a missing secret key: Manage billing says not set up and never makes the Stripe client', async () => {
    h.env.STRIPE_SECRET_KEY = undefined;
    const e = await refusal(service().createPortalSession());
    expect(e).toMatchObject({ code: 'validation_error', message: NOT_SET_UP });
    expect(h.getStripe).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
