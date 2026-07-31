import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit writer stays BEST-EFFORT — a failed insert must never break the
 * god-mode action it is logging — but it must stop being SILENT. The owner's
 * brief requires every disable, revocation and re-enable to be auditable, so a
 * caller that cares (account-status.ts) has to be able to tell that the row did
 * not land and report the operation as partial.
 */

const insert = vi.fn();
const reportError = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: (...a: unknown[]) => insert(...a) }) }),
}));

import { recordPlatformAudit } from './audit';

const INPUT = {
  actorUserId: '22222222-2222-2222-2222-222222222222',
  actorEmail: 'god@stockpilotusa.com',
  action: 'user_disabled' as const,
  targetUserId: '11111111-1111-1111-1111-111111111111',
};

describe('recordPlatformAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockResolvedValue({ error: null });
  });

  it('returns true when the row lands', async () => {
    await expect(recordPlatformAudit(INPUT)).resolves.toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_disabled', target_user_id: INPUT.targetUserId }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('returns FALSE instead of swallowing a rejected insert', async () => {
    // e.g. the 0308 CHECK constraint refusing an action value that the
    // migration has not been pushed for yet.
    insert.mockResolvedValue({ error: { message: 'violates check constraint' } });

    await expect(recordPlatformAudit(INPUT)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('returns false rather than throwing when the client blows up', async () => {
    insert.mockRejectedValue(new Error('connection reset'));

    await expect(recordPlatformAudit(INPUT)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
