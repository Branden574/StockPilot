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
 *     the recorded one is shown like any authenticator app and reported once;
 *   - before the records exist (the table missing: PostgREST PGRST205,
 *     Postgres 42P01, naming the table) nothing is hidden and nothing is
 *     reported, as today;
 *   - a read that fails any other way, throws, or answers in a shape this
 *     does not know hides nothing and is reported at error level.
 * Reports carry no id.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

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

import { reportError } from '@/lib/error-reporter';

import {
  isPasskeyBridge,
  readPasskeyBridge,
  withoutPasskeyBridge,
  type PasskeyBridge,
} from './passkey-bridge';
import { carriesBridgeName, PASSKEY_BRIDGE_NAME_PREFIX } from './passkey-bridge-name';

const USER = 'user-1';
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

  it('a reserved-name factor with no record is not hidden, and is reported once with no id', async () => {
    h.answer = { data: null, error: null };
    const bridge = await readPasskeyBridge(
      USER,
      [IMPOSTOR, APP, { ...IMPOSTOR, id: 'other-2' }],
      'sign_in_page',
    );
    expect(bridge).toEqual({ kind: 'none' });
    expect(withoutPasskeyBridge([IMPOSTOR, APP], bridge)).toEqual([IMPOSTOR, APP]);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = vi.mocked(reportError).mock.calls[0]!;
    expect(context).toEqual({
      tag: 'passkeys.reserved_name_factor_not_ours',
      level: 'warning',
      extra: { site: 'sign_in_page' },
    });
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toMatch(/other-1|other-2|user-1/);
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
      extra: { site: 'security_page' },
    });
  });

  it.each([
    ['PGRST205', "Could not find the table 'public.passkey_bridges' in the schema cache"],
    ['42P01', 'relation "public.passkey_bridges" does not exist'],
  ])('before the records exist (%s): nothing hidden, nothing reported', async (code, message) => {
    h.answer = { data: null, error: { code, message } };
    const bridge = await readPasskeyBridge(USER, [BRIDGE, APP], 'challenge');
    expect(bridge).toEqual({ kind: 'none' });
    expect(withoutPasskeyBridge([BRIDGE, APP], bridge)).toEqual([BRIDGE, APP]);
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

describe('isPasskeyBridge and withoutPasskeyBridge', () => {
  const recorded: PasskeyBridge = { kind: 'recorded', factorId: BRIDGE.id };

  it('match the recorded id only', () => {
    expect(isPasskeyBridge(recorded, BRIDGE.id)).toBe(true);
    expect(isPasskeyBridge(recorded, APP.id)).toBe(false);
    expect(isPasskeyBridge(recorded, undefined)).toBe(false);
    expect(isPasskeyBridge({ kind: 'none' }, BRIDGE.id)).toBe(false);
    expect(isPasskeyBridge({ kind: 'unreadable' }, BRIDGE.id)).toBe(false);
  });

  it('remove the recorded factor whatever the order (the order flips with use)', () => {
    expect(withoutPasskeyBridge([BRIDGE, APP], recorded)).toEqual([APP]);
    expect(withoutPasskeyBridge([APP, BRIDGE], recorded)).toEqual([APP]);
    expect(withoutPasskeyBridge([BRIDGE], recorded)).toEqual([]);
  });
});
