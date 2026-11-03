import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PLATFORM ACTIONS WITHOUT THE SERVICE-ROLE KEY SAY "NOT SET UP" (S31).
 *
 * Provision, the deletion passphrase and Remove organization answered the
 * setting's name ("Server is missing SUPABASE_SERVICE_ROLE_KEY. Check Vercel
 * env config.") when the admin client could not be made. A Server Action's
 * result reaches the browser as it is: the operator now reads "This feature
 * is not set up yet.", and the report names the setting.
 */

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/server/services/platform/audit', () => ({ recordPlatformAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'pa-1', email: 'ops@example.test' },
  })),
  isPlatformAdmin: () => false,
}));
vi.mock('@/lib/auth/platform-passphrase', () => ({
  hashPassphrase: vi.fn(),
  verifyPassphrase: vi.fn(() => true),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }),
}));

import {
  createOrgForCustomerAction,
  removeOrgAction,
  setOrgDeletionPassphraseAction,
} from './platform-admin';

const NOT_SET_UP = {
  ok: false,
  error: { code: 'internal_error', message: 'This feature is not set up yet.' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('platform actions without the service-role key (S31)', () => {
  it.each([
    [
      'Provision',
      () =>
        createOrgForCustomerAction({
          email: 'new.customer@example.test',
          name: 'Example Customer',
          timezone: 'America/New_York',
        }),
      'actions.platform_admin.create_org_for_customer',
    ],
    [
      'the deletion passphrase',
      () => setOrgDeletionPassphraseAction({ passphrase: 'a-long-enough-phrase' }),
      'actions.platform_admin.set_org_deletion_passphrase',
    ],
    [
      'Remove organization',
      () =>
        removeOrgAction({
          orgId: '0a000000-0000-4000-8000-000000000099',
          passphrase: 'a-long-enough-phrase',
          confirmName: 'Example Customer',
        }),
      'actions.platform_admin.remove_org',
    ],
  ] as const)(
    '%s says not set up, never the setting, reported as a warning',
    async (_label, act, tag) => {
      const res = await act();
      expect(res).toEqual(NOT_SET_UP);
      expect(JSON.stringify(res)).not.toMatch(/SUPABASE|Vercel|env/);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect((reportError.mock.calls[0] as unknown[])[1]).toEqual({ tag, level: 'warning' });
    },
  );
});
