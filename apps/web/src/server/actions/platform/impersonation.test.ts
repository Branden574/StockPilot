import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * startActingAsAction's sentences: an organization that does not exist is
 * "not found"; one that could not be read says so, and that nothing changed.
 */

const { startActingAs } = vi.hoisted(() => ({
  startActingAs: vi.fn(async (_input: unknown) => ({ ok: true as boolean, reason: undefined as string | undefined })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'a0000000-0000-4000-8000-000000000001', email: 'ops@example.test' },
  })),
  currentUserIsPlatformAdmin: vi.fn(async () => true),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/server/services/platform/impersonation', () => ({ startActingAs, stopActingAs: vi.fn() }));

import { ACT_AS_ONLY_OWNER_COPY, ORGANIZATION_OWNER_BUSY_COPY } from '@/server/lib/organization-owner-rule';

import { startActingAsAction } from './impersonation';

const INPUT = { organizationId: '0a000000-0000-4000-8000-000000000002' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startActingAsAction', () => {
  it('says the organization could not be read and nothing changed', async () => {
    startActingAs.mockResolvedValueOnce({ ok: false, reason: 'org_unreadable' });
    await expect(startActingAsAction(INPUT)).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not read the organization, so nothing was changed. Try again.',
      },
    });
  });

  it('an organization that does not exist is not found', async () => {
    startActingAs.mockResolvedValueOnce({ ok: false, reason: 'org_not_found' });
    await expect(startActingAsAction(INPUT)).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Organization not found.' },
    });
  });

  // Migration 0458: the database's owner rule, read by the service.
  it('the admin is the only owner of the organization: Act as did not start', async () => {
    startActingAs.mockResolvedValueOnce({ ok: false, reason: 'only_owner' });
    await expect(startActingAsAction(INPUT)).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', message: ACT_AS_ONLY_OWNER_COPY },
    });
  });

  it('the owner check is busy: try again in a minute', async () => {
    startActingAs.mockResolvedValueOnce({ ok: false, reason: 'owner_check_busy' });
    await expect(startActingAsAction(INPUT)).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', message: ORGANIZATION_OWNER_BUSY_COPY },
    });
  });
});
