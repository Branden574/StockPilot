import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportErrorMock, insertAuditRowReportedMock } = vi.hoisted(() => ({
  reportErrorMock: vi.fn(async () => undefined),
  insertAuditRowReportedMock: vi.fn(async (_row: Record<string, unknown>) => true),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: insertAuditRowReportedMock }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'UA/1' })),
}));

import {
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_SIGNED_OUT_COPY,
  auditAccountDeleted,
  checkAccountDeletable,
  settleFailedDelete,
} from './account-deletion';

/**
 * The server's question before it deletes an account (migration 0388):
 * account_deletion_check dry-runs the real delete and always undoes it. Every
 * answer but "deletable" must make the caller change nothing, so the mapping
 * from the function's JSON to the four refusal kinds is pinned here.
 */
function adminAnswering(res: { data: unknown; error: { code?: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  return { admin: { rpc } as never, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkAccountDeletable', () => {
  it('asks account_deletion_check with the user id, and deletable is ok', async () => {
    const { admin, rpc } = adminAnswering({ data: { deletable: true }, error: null });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('account_deletion_check', { p_user_id: 'u-1' });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a kept record refuses: blocked, with the constraint and table (reported at info, names only)', async () => {
    const { admin } = adminAnswering({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: '23503',
        constraint: 'po_imports_uploaded_by_fkey',
        table: 'public.po_imports',
      },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'mobile')).resolves.toEqual({
      ok: false,
      kind: 'blocked',
      sqlstate: '23503',
      constraint: 'po_imports_uploaded_by_fkey',
      table: 'public.po_imports',
    });
    expect(reportErrorMock).toHaveBeenCalledWith(expect.anything(), {
      tag: 'account.delete.blocked',
      level: 'info',
      extra: {
        source: 'mobile',
        sqlstate: '23503',
        constraint: 'po_imports_uploaded_by_fkey',
        table: 'public.po_imports',
      },
    });
  });

  it('a NOT NULL refusal with no constraint name is still blocked (the generic path)', async () => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate: '23502', constraint: null, table: 'public.platform_admin_audit' },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'blocked',
      sqlstate: '23502',
      table: 'public.platform_admin_audit',
    });
  });

  it.each([['55P03'], ['40P01']])('a lock wait or a deadlock (%s) is retry, not blocked', async (sqlstate) => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate, constraint: null, table: null },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'retry',
      sqlstate,
    });
  });

  // Review R1 (2026-10-03): the SQL function returns EVERY error its
  // subtransaction catches as reason 'blocked'. Only an integrity refusal
  // (SQLSTATE class 23: a RESTRICT or NO ACTION key, a CHECK, a NOT NULL) is a
  // record the organization keeps. Anything else is the system failing (a
  // read-only transaction answered 25006 and a lost DELETE privilege 42501 in
  // rolled-back probes), which must say "try again" and be reported as an
  // error, never "linked to records" at info level.
  it.each([['23514'], ['23503'], ['23502'], ['23505'], ['23P01'], ['23001']])(
    'an integrity refusal (%s, class 23) is blocked',
    async (sqlstate) => {
      const { admin } = adminAnswering({
        data: { deletable: false, reason: 'blocked', sqlstate, constraint: 'some_chk', table: 'public.t' },
        error: null,
      });
      await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
        ok: false,
        kind: 'blocked',
        sqlstate,
        constraint: 'some_chk',
        table: 'public.t',
      });
    },
  );

  it.each([
    ['25006', 'a read-only transaction'],
    ['42501', 'a privilege the check lost'],
    ['42703', 'a column a half-applied revert dropped'],
    ['XX000', 'an internal error'],
    ['53100', 'a full disk'],
    ['P0001', 'a raise from a trigger in the cascade'],
  ])(
    'a non-integrity error (%s, %s) is check_failed, reported as an error, never "linked records"',
    async (sqlstate) => {
      const { admin } = adminAnswering({
        data: { deletable: false, reason: 'blocked', sqlstate, constraint: null, table: null },
        error: null,
      });
      await expect(checkAccountDeletable(admin, 'u-1', 'mobile')).resolves.toEqual({
        ok: false,
        kind: 'check_failed',
        sqlstate,
      });
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      const ctx = (reportErrorMock.mock.calls[0] as unknown[])[1] as {
        tag: string;
        level?: string;
        extra: Record<string, unknown>;
      };
      expect(ctx.tag).toBe('account.delete.check_failed');
      expect(ctx.level ?? 'error').toBe('error');
      expect(ctx.extra).toEqual({ source: 'mobile', sqlstate, constraint: null, table: null });
    },
  );

  it('a blocked answer with no sqlstate is check_failed (it cannot be told from a fault)', async () => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', constraint: null, table: null },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
  });

  it('not_found is gone (an account already deleted)', async () => {
    const { admin } = adminAnswering({ data: { deletable: false, reason: 'not_found' }, error: null });
    await expect(checkAccountDeletable(admin, 'u-1', 'platform')).resolves.toEqual({
      ok: false,
      kind: 'gone',
    });
  });

  it.each([
    ['an RPC error', { data: null, error: { code: '57014' } }],
    ['no_user', { data: { deletable: false, reason: 'no_user' }, error: null }],
    ['an unknown shape', { data: { something: 'else' }, error: null }],
    ['a null answer', { data: null, error: null }],
  ])('%s fails closed (check_failed) and is reported', async (_label, res) => {
    const { admin } = adminAnswering(res);
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.check_failed' }),
    );
  });

  it('a thrown client error fails closed, never throws', async () => {
    const { admin } = adminAnswering(new Error('fetch failed'));
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
  });

  it('a truthy but non-true deletable is not deletable', async () => {
    const { admin } = adminAnswering({ data: { deletable: 'true' }, error: null });
    const res = await checkAccountDeletable(admin, 'u-1', 'web');
    expect(res.ok).toBe(false);
  });
});

/**
 * Review R7 (2026-10-03): deleteUser can answer an error although the account
 * is gone. Two cases: GoTrue committed and the reply was lost (a fetch
 * timeout, AuthRetryableFetchError status 0), or another request (the same
 * person's phone and browser at once) deleted it first, so this DELETE found
 * no user (404 user_not_found; shape read from the local GoTrue,
 * a2-evidence/review-gotrue-shapes.log). The caller must not tell the person
 * "could not be deleted" then.
 */
describe('settleFailedDelete', () => {
  function adminWith(getUserById: (id: string) => Promise<unknown>) {
    const fn = vi.fn(getUserById);
    return { admin: { auth: { admin: { getUserById: fn } } } as never, getUserById: fn };
  }
  const NOT_FOUND = { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' };
  const LOST_REPLY = { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' };

  it('404 user_not_found to the DELETE itself: deleted elsewhere, no second question', async () => {
    const { admin, getUserById } = adminWith(async () => ({ data: { user: null }, error: NOT_FOUND }));
    await expect(settleFailedDelete(admin, 'u-1', NOT_FOUND)).resolves.toBe('deleted_elsewhere');
    expect(getUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['a lost reply (status 0)', LOST_REPLY],
    ['a 500 from GoTrue', { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'x' }],
  ])('%s, then GoTrue says the user does not exist: this request deleted it', async (_l, delErr) => {
    const { admin, getUserById } = adminWith(async () => ({ data: { user: null }, error: NOT_FOUND }));
    await expect(settleFailedDelete(admin, 'u-1', delErr)).resolves.toBe('deleted');
    expect(getUserById).toHaveBeenCalledWith('u-1');
  });

  it('the account is still there: not deleted', async () => {
    const { admin } = adminWith(async () => ({ data: { user: { id: 'u-1' } }, error: null }));
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('GoTrue cannot answer the second question either: not deleted (fail closed)', async () => {
    const { admin } = adminWith(async () => ({ data: { user: null }, error: LOST_REPLY }));
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('a thrown second question: not deleted, never throws', async () => {
    const { admin } = adminWith(async () => {
      throw new Error('admin client unusable');
    });
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('a 404 without the user_not_found code is not taken as proof', async () => {
    const { admin } = adminWith(async () => ({ data: { user: { id: 'u-1' } }, error: null }));
    await expect(
      settleFailedDelete(admin, 'u-1', { name: 'AuthApiError', status: 404, message: 'Not Found' }),
    ).resolves.toBe('not_deleted');
  });
});

describe('auditAccountDeleted', () => {
  it('writes user.deactivated with user_id null, the entity id, the reason, ip and user agent', async () => {
    await auditAccountDeleted({ userId: 'u-1', organizationId: 'org-1', reason: 'self_deletion' });
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith({
      organization_id: 'org-1',
      user_id: null,
      event: 'user.deactivated',
      ip: '203.0.113.7',
      user_agent: 'UA/1',
      metadata: {
        entity_type: 'user',
        entity_id: 'u-1',
        warehouse_id: null,
        before: null,
        after: null,
        reason: 'self_deletion',
      },
    });
  });

  it('a person with no organization (SP-129) is written with organization_id null', async () => {
    await auditAccountDeleted({ userId: 'u-2', organizationId: null, reason: 'self_deletion_mobile' });
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: null, user_id: null }),
    );
  });
});

describe('the sentences', () => {
  it('say nothing changed, in plain words', () => {
    expect(ACCOUNT_DELETE_BLOCKED_COPY).toContain('Nothing was changed.');
    expect(ACCOUNT_DELETE_BLOCKED_COPY).toContain('Contact StockPilot support');
    expect(ACCOUNT_DELETE_RETRY_COPY).toBe(
      'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
    );
    expect(ACCOUNT_DELETE_SIGNED_OUT_COPY).toContain('You have been signed out');
    for (const s of [ACCOUNT_DELETE_BLOCKED_COPY, ACCOUNT_DELETE_RETRY_COPY, ACCOUNT_DELETE_SIGNED_OUT_COPY]) {
      expect(s.toLowerCase()).not.toMatch(/\bbook\b/);
    }
  });
});
