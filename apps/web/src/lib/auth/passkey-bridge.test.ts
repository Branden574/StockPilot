import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the web hides and refuses a passkey's bridge factor BY
 * ITS RECORDED ID ONLY (lib/auth/passkey-bridge.ts).
 *
 * A passkey signs in through a hidden authenticator-app factor at Supabase
 * Auth (the bridge). Its id is recorded in public.passkey_bridges by the
 * server; its name starts with the reserved prefix, which is only the trigger
 * for reading that record, never a proof. So:
 *   - a list with no reserved-name factor reads nothing;
 *   - the recorded id is the one hidden; a reserved-name factor that is not
 *     the recorded one is shown like any authenticator app and reported at
 *     warning level, at most once per account per hour (a closed limiter);
 *   - the table missing (PostgREST PGRST205, Postgres 42P01, naming the
 *     table: before 0475 is live, or a schema cache that lost it) hides
 *     nothing; with a reserved-name factor listed it is reported at error
 *     level, at most once per hour for every account together (review 2-3
 *     finding 3);
 *   - a read that fails any other way, throws, or answers in a shape this
 *     does not know hides nothing and is reported at error level;
 *   - an action that CHANGES a factor (removal, confirming a set-up, the
 *     set-up clean-up) leaves the recorded bridge alone, and, while the
 *     record cannot be read, every factor that carries the reserved name
 *     (review 2-3 finding 2). A factor without the name is never held back.
 * Reports carry no factor id and no account id; the account-level ones carry
 * a hash of the account id.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));

const h = vi.hoisted(() => ({
  answer: { data: null as unknown, error: null as unknown },
  throws: null as Error | null,
  reads: [] as Array<{ table: string; select: string; eq: [string, unknown] }>,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    if (h.throws) throw h.throws;
    return {
      from: (table: string) => ({
        select: (select: string) => ({
          eq: (column: string, value: unknown) => {
            h.reads.push({ table, select, eq: [column, value] });
            return { maybeSingle: async () => h.answer };
          },
        }),
      }),
    };
  }),
}));

import { createHash } from 'node:crypto';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';

import {
  accountIdHash,
  appFactorsForCode,
  factorChangeRefusal,
  refusedForCode,
  isPasskeyBridge,
  readPasskeyBridge,
  reportPasskeyRecordsMissing,
  withoutPasskeyBridge,
  type PasskeyBridge,
} from './passkey-bridge';
import { carriesBridgeName, PASSKEY_BRIDGE_NAME_PREFIX } from './passkey-bridge-name';

const USER = 'user-1';
/** The house hash of an account id in a report (lib/auth/login-device.ts). */
const USER_HASH = createHash('sha256').update(USER).digest('hex').slice(0, 16);
const HOUR_MS = 60 * 60_000;
const LIMIT_REFUSED = { allowed: false, count: 1, resetAt: Date.now() + 1000 };
const APP = { id: 'app-1', status: 'verified', friendly_name: 'StockPilot · 2026-11-01' };
const BRIDGE = { id: 'bridge-1', status: 'verified', friendly_name: 'sp-passkey-bridge-a1b2c3' };
/** A reserved-name factor that is not the recorded bridge (made at Auth directly). */
const IMPOSTOR = { id: 'other-1', status: 'verified', friendly_name: 'sp-passkey-bridge-zzz' };

beforeEach(() => {
  vi.clearAllMocks();
  h.answer = { data: null, error: null };
  h.throws = null;
  h.reads = [];
});

describe('the reserved name', () => {
  it('is sp-passkey-bridge- (the same prefix 0475 checks before it records a bridge)', () => {
    expect(PASSKEY_BRIDGE_NAME_PREFIX).toBe('sp-passkey-bridge-');
  });

  it('is read from the factor name only, and only as a prefix', () => {
    expect(carriesBridgeName(BRIDGE)).toBe(true);
    expect(carriesBridgeName(APP)).toBe(false);
    expect(carriesBridgeName({ friendly_name: 'My sp-passkey-bridge-x' })).toBe(false);
    expect(carriesBridgeName({ friendly_name: 'SP-PASSKEY-BRIDGE-x' })).toBe(false);
    expect(carriesBridgeName({ friendly_name: null })).toBe(false);
    expect(carriesBridgeName({})).toBe(false);
  });
});

describe('readPasskeyBridge', () => {
  it('reads nothing when no factor carries the reserved name', async () => {
    const bridge = await readPasskeyBridge(USER, [APP], 'challenge');
    expect(bridge).toEqual({ kind: 'none' });
    expect(h.reads).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reads the account's own record, by its id, with the service role, and returns the recorded factor", async () => {
    h.answer = { data: { factor_id: BRIDGE.id }, error: null };
    const bridge = await readPasskeyBridge(USER, [APP, BRIDGE], 'challenge');
    expect(bridge).toEqual({ kind: 'recorded', factorId: BRIDGE.id });
    expect(h.reads).toEqual([
      { table: 'passkey_bridges', select: 'factor_id', eq: ['user_id', USER] },
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a reserved-name factor with no record is not hidden, and is reported once with the account hash only', async () => {
    h.answer = { data: null, error: null };
    const bridge = await readPasskeyBridge(
      USER,
      [IMPOSTOR, APP, { ...IMPOSTOR, id: 'other-2' }],
      'sign_in_page',
    );
    // The records were read, and none names this account.
    expect(bridge).toEqual({ kind: 'none', noRecord: true });
    expect(withoutPasskeyBridge([IMPOSTOR, APP], bridge)).toEqual([IMPOSTOR, APP]);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = vi.mocked(reportError).mock.calls[0]!;
    expect(context).toEqual({
      tag: 'passkeys.reserved_name_factor_not_ours',
      level: 'warning',
      userIdHash: USER_HASH,
      extra: { site: 'sign_in_page' },
    });
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toMatch(/other-1|other-2|user-1/);
  });

  it('the "not ours" warning is limited: one per account per hour, through a closed limiter', async () => {
    h.answer = { data: null, error: null };
    await readPasskeyBridge(USER, [IMPOSTOR], 'challenge');
    expect(checkRateLimit).toHaveBeenCalledWith(
      `passkeys-not-ours-report:${USER}`,
      1,
      HOUR_MS,
      'closed',
    );
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValueOnce(LIMIT_REFUSED);
    const bridge = await readPasskeyBridge(USER, [IMPOSTOR], 'challenge');
    expect(bridge).toEqual({ kind: 'none', noRecord: true });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an account with no reserved-name factor spends no limiter count', async () => {
    await readPasskeyBridge(USER, [APP], 'challenge');
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('a reserved-name factor beside the recorded bridge is not hidden, and is reported once', async () => {
    h.answer = { data: { factor_id: BRIDGE.id }, error: null };
    const bridge = await readPasskeyBridge(USER, [BRIDGE, IMPOSTOR, APP], 'security_page');
    expect(bridge).toEqual({ kind: 'recorded', factorId: BRIDGE.id });
    expect(withoutPasskeyBridge([BRIDGE, IMPOSTOR, APP], bridge)).toEqual([IMPOSTOR, APP]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'passkeys.reserved_name_factor_not_ours',
      level: 'warning',
      userIdHash: USER_HASH,
      extra: { site: 'security_page' },
    });
  });

  it.each([
    ['PGRST205', "Could not find the table 'public.passkey_bridges' in the schema cache"],
    ['42P01', 'relation "public.passkey_bridges" does not exist'],
  ])(
    'the table missing (%s) with a reserved-name factor listed: nothing hidden, one error report per hour for every account',
    async (code, message) => {
      h.answer = { data: null, error: { code, message } };
      const bridge = await readPasskeyBridge(USER, [BRIDGE, APP], 'challenge');
      expect(bridge).toEqual({ kind: 'none' });
      expect(withoutPasskeyBridge([BRIDGE, APP], bridge)).toEqual([BRIDGE, APP]);
      expect(checkRateLimit).toHaveBeenCalledWith(
        'passkeys-records-missing-report:table',
        1,
        HOUR_MS,
        'closed',
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect(context).toEqual({
        tag: 'passkeys.records_missing',
        level: 'error',
        userIdHash: USER_HASH,
        extra: { missing: 'table', site: 'challenge' },
      });
      expect(JSON.stringify([String(reported), context])).not.toMatch(/bridge-1|user-1/);
    },
  );

  it('the table missing, a second time in the hour: nothing reported', async () => {
    h.answer = {
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.passkey_bridges' in the schema cache",
      },
    };
    vi.mocked(checkRateLimit).mockResolvedValueOnce(LIMIT_REFUSED);
    expect(await readPasskeyBridge(USER, [BRIDGE], 'unenroll')).toEqual({ kind: 'none' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('the table missing and no reserved-name factor: no read, no limiter count, no report', async () => {
    h.answer = {
      data: null,
      error: { code: '42P01', message: 'relation "public.passkey_bridges" does not exist' },
    };
    expect(await readPasskeyBridge(USER, [APP], 'challenge')).toEqual({ kind: 'none' });
    expect(h.reads).toEqual([]);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a missing-table code that names another table is a failed read', async () => {
    h.answer = {
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.other' in the schema cache",
      },
    };
    expect(await readPasskeyBridge(USER, [BRIDGE], 'challenge')).toEqual({ kind: 'unreadable' });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  const unreadable: Array<[string, () => void]> = [
    [
      'a database error',
      () => (h.answer = { data: null, error: { code: '57014', message: 'canceling statement' } }),
    ],
    [
      'the service client missing (no key)',
      () => (h.throws = new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')),
    ],
    ['an answer with no factor id', () => (h.answer = { data: { factor_id: null }, error: null })],
    ['an answer that is not a row', () => (h.answer = { data: 'bridge-1', error: null })],
  ];
  it.each(unreadable)(
    '%s: nothing hidden, reported at error level with no id',
    async (_name, arrange) => {
      arrange();
      const bridge = await readPasskeyBridge(USER, [BRIDGE, APP], 'unenroll');
      expect(bridge).toEqual({ kind: 'unreadable' });
      expect(withoutPasskeyBridge([BRIDGE, APP], bridge)).toEqual([BRIDGE, APP]);
      expect(isPasskeyBridge(bridge, BRIDGE.id)).toBe(false);
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect(context).toMatchObject({
        tag: 'passkeys.bridge_unreadable',
        level: 'error',
        extra: { site: 'unenroll' },
      });
      expect(JSON.stringify([String(reported), context])).not.toMatch(/bridge-1|user-1|SUPABASE/);
    },
  );
});

describe('reportPasskeyRecordsMissing (the recovery code: the function missing)', () => {
  it('reports at error level, once per hour FOR EACH ACCOUNT, with the account hash only', async () => {
    await reportPasskeyRecordsMissing('function', 'recovery_code', USER);
    expect(checkRateLimit).toHaveBeenCalledWith(
      `passkeys-records-missing-report:function:${USER}`,
      1,
      HOUR_MS,
      'closed',
    );
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'passkeys.records_missing',
      level: 'error',
      userIdHash: USER_HASH,
      extra: { missing: 'function', site: 'recovery_code' },
    });
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValueOnce(LIMIT_REFUSED);
    await reportPasskeyRecordsMissing('function', 'recovery_code', USER);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('another account in the same hour is named too (its own key); the table stays one for all', async () => {
    await reportPasskeyRecordsMissing('function', 'recovery_code', 'user-2');
    expect(checkRateLimit).toHaveBeenCalledWith(
      'passkeys-records-missing-report:function:user-2',
      1,
      HOUR_MS,
      'closed',
    );
    vi.clearAllMocks();
    await reportPasskeyRecordsMissing('table', 'sign_in_page', 'user-2');
    expect(checkRateLimit).toHaveBeenCalledWith(
      'passkeys-records-missing-report:table',
      1,
      HOUR_MS,
      'closed',
    );
  });

  it('the account hash is the house one (sha-256, first 16 hex characters)', () => {
    expect(accountIdHash(USER)).toBe(USER_HASH);
    expect(accountIdHash(USER)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('factorChangeRefusal: what an action that changes a factor must leave alone', () => {
  const recorded: PasskeyBridge = { kind: 'recorded', factorId: BRIDGE.id };
  const unreadable: PasskeyBridge = { kind: 'unreadable' };

  it('the recorded bridge, always', () => {
    expect(factorChangeRefusal(recorded, BRIDGE)).toBe('passkey_bridge');
  });

  it('while the record cannot be read, every factor that carries the reserved name', () => {
    expect(factorChangeRefusal(unreadable, BRIDGE)).toBe('bridge_unreadable');
    expect(factorChangeRefusal(unreadable, IMPOSTOR)).toBe('bridge_unreadable');
  });

  it('never a factor without the reserved name, whatever the record says', () => {
    expect(factorChangeRefusal(unreadable, APP)).toBeNull();
    expect(factorChangeRefusal(recorded, APP)).toBeNull();
    expect(factorChangeRefusal({ kind: 'none' }, APP)).toBeNull();
  });

  it('a reserved-name factor that is not the recorded one, or with no record, or before the records exist', () => {
    expect(factorChangeRefusal(recorded, IMPOSTOR)).toBeNull();
    expect(factorChangeRefusal({ kind: 'none' }, BRIDGE)).toBeNull();
  });
});

describe('isPasskeyBridge and withoutPasskeyBridge', () => {
  const recorded: PasskeyBridge = { kind: 'recorded', factorId: BRIDGE.id };

  it('match the recorded id only', () => {
    expect(isPasskeyBridge(recorded, BRIDGE.id)).toBe(true);
    expect(isPasskeyBridge(recorded, APP.id)).toBe(false);
    expect(isPasskeyBridge(recorded, undefined)).toBe(false);
    expect(isPasskeyBridge({ kind: 'none' }, BRIDGE.id)).toBe(false);
    expect(isPasskeyBridge({ kind: 'unreadable' }, BRIDGE.id)).toBe(false);
  });

  it('remove the recorded factor whatever the order (it flips with use: proof B7)', () => {
    expect(withoutPasskeyBridge([BRIDGE, APP], recorded)).toEqual([APP]);
    expect(withoutPasskeyBridge([APP, BRIDGE], recorded)).toEqual([APP]);
    expect(withoutPasskeyBridge([BRIDGE], recorded)).toEqual([]);
  });
});

describe('appFactorsForCode: the apps a code can be asked for (the code page, the step-up modal, the password reset)', () => {
  const recorded: PasskeyBridge = { kind: 'recorded', factorId: BRIDGE.id };

  it('once the records are read, no factor that carries the reserved name: not the recorded bridge, not one no record names', () => {
    expect(appFactorsForCode([BRIDGE, IMPOSTOR, APP], recorded)).toEqual([APP]);
    expect(appFactorsForCode([IMPOSTOR, BRIDGE], recorded)).toEqual([]);
    expect(appFactorsForCode([IMPOSTOR, APP], { kind: 'none', noRecord: true })).toEqual([APP]);
    expect(appFactorsForCode([IMPOSTOR], { kind: 'none', noRecord: true })).toEqual([]);
  });

  it('the apps keep their order', () => {
    const second = { ...APP, id: 'app-2' };
    expect(appFactorsForCode([second, IMPOSTOR, APP], recorded)).toEqual([second, APP]);
  });

  it('before the records exist, and while they cannot be read, the pick is stage 2’s: by the recorded id only', () => {
    expect(appFactorsForCode([BRIDGE, APP], { kind: 'none' })).toEqual([BRIDGE, APP]);
    expect(appFactorsForCode([BRIDGE, APP], { kind: 'unreadable' })).toEqual([BRIDGE, APP]);
  });
});

describe('refusedForCode: the code check (the lab walk of stage 4, state S12)', () => {
  const recorded: PasskeyBridge = { kind: 'recorded', factorId: BRIDGE.id };
  const noRecord: PasskeyBridge = { kind: 'none', noRecord: true };

  it('refuses the recorded bridge, and once the records are read a reserved-name factor no record names', () => {
    expect(refusedForCode(recorded, BRIDGE)).toBe('passkey_bridge');
    expect(refusedForCode(recorded, IMPOSTOR)).toBe('reserved_name_unrecorded');
    expect(refusedForCode(noRecord, IMPOSTOR)).toBe('reserved_name_unrecorded');
  });

  it('never an app', () => {
    expect(refusedForCode(recorded, APP)).toBeNull();
    expect(refusedForCode(noRecord, APP)).toBeNull();
  });

  it('before the records exist, and while they cannot be read: nothing is refused (stage 2 as before)', () => {
    expect(refusedForCode({ kind: 'none' }, IMPOSTOR)).toBeNull();
    expect(refusedForCode({ kind: 'unreadable' }, IMPOSTOR)).toBeNull();
    expect(refusedForCode({ kind: 'unreadable' }, BRIDGE)).toBeNull();
  });
});
