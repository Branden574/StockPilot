import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * PLATFORM BILLING'S OWN REFUSALS KEEP THEIR WORDS (S31).
 *
 * setBilling and startTrial threw plain Errors for their own refusals (an
 * invalid tier or arrangement, an organization that is gone). The billing
 * actions now answer a plain Error with the fixed sentence and report it, so
 * those refusals are ServiceErrors: the operator still reads "Organization
 * not found." A database error stays a plain Error, so its text is reported
 * and never answered.
 */

const h = vi.hoisted(() => ({
  stub: null as ReturnType<typeof import('@/test/supabase-mock').makeSupabaseStub> | null,
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.stub!.client }));
vi.mock('./audit', () => ({ recordPlatformAudit: vi.fn(async () => {}) }));

import { ServiceError } from '../context';

import { setBilling, startTrial } from './billing';

const ORG = '0a000000-0000-4000-8000-000000000001';
const base = {
  actorUserId: 'pa-1',
  actorEmail: 'ops@example.test',
  organizationId: ORG,
  accessTier: 'pro' as const,
  arrangement: 'comped' as const,
  customPriceCents: null,
  customPriceInterval: null,
  allModulesComp: false,
  billingNotes: null,
};

function updateAnswers(answer: { data: unknown; error: { message: string } | null }) {
  h.stub = makeSupabaseStub({ 'organizations.update': answer });
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  updateAnswers({ data: { id: ORG }, error: null });
});

describe('platform billing refusals are ServiceErrors with their words (S31)', () => {
  it.each([
    [
      'an invalid access tier',
      () => setBilling({ ...base, accessTier: 'gold' as never }),
      'Invalid access tier',
    ],
    [
      'an invalid arrangement',
      () => setBilling({ ...base, arrangement: 'barter' as never }),
      'Invalid billing arrangement',
    ],
    [
      'an invalid trial tier',
      () => startTrial({ ...base, days: 14, trialTier: 'gold' as never, now: 0 }),
      'Invalid trial tier',
    ],
  ])('%s: a validation_error', async (_label, act, message) => {
    const e = await thrown(act());
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'validation_error', message });
  });

  it.each([
    ['setBilling', () => setBilling(base)],
    ['startTrial', () => startTrial({ ...base, days: 14, trialTier: 'pro', now: 0 })],
  ])(
    '%s on an organization that is gone: not_found "Organization not found."',
    async (_label, act) => {
      updateAnswers({ data: null, error: null });
      const e = await thrown(act());
      expect(e).toBeInstanceOf(ServiceError);
      expect(e).toMatchObject({ code: 'not_found', message: 'Organization not found.' });
    },
  );

  it('a database error stays a plain Error, for the action to report and never answer', async () => {
    updateAnswers({ data: null, error: { message: 'permission denied for table organizations' } });
    const e = await thrown(setBilling(base));
    expect(e).not.toBeInstanceOf(ServiceError);
    expect((e as Error).message).toBe('permission denied for table organizations');
  });
});
