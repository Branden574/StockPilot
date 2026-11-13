import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * setOrgDeletionPassphraseAction: changing a stored deletion passphrase needs
 * the current one, and the stored one is read first. A read that answers an
 * error refuses the change with a plain sentence and a report; it never counts
 * as "no passphrase yet", which is the only case that needs no current one.
 */

const { reportError, recordPlatformAudit, verifyPassphrase } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  recordPlatformAudit: vi.fn(async (_row: unknown) => {}),
  verifyPassphrase: vi.fn((_typed: string, _hash: string, _salt: string) => false),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/server/services/platform/audit', () => ({ recordPlatformAudit }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'pa-1', email: 'ops@example.test' },
  })),
  isPlatformAdmin: () => false,
}));
vi.mock('@/lib/auth/platform-passphrase', () => ({
  hashPassphrase: vi.fn(() => ({ hash: 'new-hash', salt: 'new-salt' })),
  verifyPassphrase,
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));

/** What the platform_settings read answers in each test. */
let settingsRead: QueryResult = { data: null, error: null };

const adminStub = makeSupabaseStub({
  'platform_settings.select': () => settingsRead,
  'platform_settings.insert': { data: null, error: null },
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { setOrgDeletionPassphraseAction } from './platform-admin';

const saves = () => adminStub.chainsAll.get('platform_settings.insert')?.length ?? 0;

beforeEach(() => {
  vi.clearAllMocks();
  verifyPassphrase.mockImplementation(() => false);
  settingsRead = { data: null, error: null };
});

describe('setOrgDeletionPassphraseAction', () => {
  it('refuses the change when the stored passphrase could not be read', async () => {
    settingsRead = {
      data: null,
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    };
    const before = saves();
    const res = await setOrgDeletionPassphraseAction({ passphrase: 'a-long-enough-phrase' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not read the current deletion passphrase, so it was not changed. Try again.',
      },
    });
    expect(saves()).toBe(before);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform-admin.passphrase-read' }),
    );
  });

  it('refuses the change when a passphrase is stored and the current one does not match', async () => {
    settingsRead = {
      data: { org_deletion_passphrase_hash: 'h', org_deletion_passphrase_salt: 's' },
      error: null,
    };
    const before = saves();
    const res = await setOrgDeletionPassphraseAction({
      passphrase: 'a-long-enough-phrase',
      currentPassphrase: 'not-the-current-one',
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Enter the current deletion passphrase to change it.' },
    });
    expect(saves()).toBe(before);
  });

  it('saves the first passphrase when none is stored yet', async () => {
    const before = saves();
    const res = await setOrgDeletionPassphraseAction({ passphrase: 'a-long-enough-phrase' });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(saves()).toBe(before + 1);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deletion_passphrase_set' }),
    );
  });
});
