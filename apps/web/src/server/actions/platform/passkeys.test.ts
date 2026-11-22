import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

/**
 * The platform console's passkey switches (plan 2.6 H): the kill switch
 * (platform_settings.passkeys_on), "new passkeys" (passkey_adds_on, review
 * U6) and one organization's switch (a row in organization_passkey_switches).
 *
 * Pinned: checkPlatformAdmin({ requireStepUp: true }) is asked first and a
 * refusal (not an admin, no fresh step-up) reads and writes nothing; the
 * typed word is exactly PASSKEYS or nothing is read or written; the settings
 * row is UPSERTED (it may not exist in production, review F) with only the
 * one column, so the other settings and the deletion passphrase are kept; an
 * audit row with { from, to } for every change and none for a press that
 * changed nothing; an ON whose audit row does not land is refused before
 * anything is switched; an OFF stands without it and says so; a write applies
 * only while the switch still holds the value read; an organization turned
 * off answers how many of its members still hold an active passkey.
 *
 * Made-up ids and addresses only.
 */

/** The gate's session: its email is the profile column (member-writable). */
const ADMIN = {
  userId: '0a000000-0000-4000-8000-000000000001',
  email: 'profile-column@example.test',
};
/** The email Auth verified for the request: the audit row's actor. */
const VERIFIED_EMAIL = 'operator@example.test';
const ORG = '0b000000-0000-4000-8000-000000000001';
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002';
const U1 = '0c000000-0000-4000-8000-000000000001';
const U2 = '0c000000-0000-4000-8000-000000000002';
const U3 = '0c000000-0000-4000-8000-000000000003';
const U4 = '0c000000-0000-4000-8000-000000000004';

const h = vi.hoisted(() => ({
  gate: vi.fn(async (_opts?: unknown): Promise<unknown> => ({ ok: true, session: null })),
  recordPlatformAudit: vi.fn(async (_row: unknown): Promise<boolean> => true),
  reportError: vi.fn(async () => {}),
  revalidatePath: vi.fn(),
  adminThrows: false,
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/platform/audit', () => ({ recordPlatformAudit: h.recordPlatformAudit }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: (opts?: unknown) => h.gate(opts),
}));

/** The database as these tests see it. */
type SettingsRow = {
  id: true;
  passkeys_on: boolean;
  passkey_adds_on: boolean;
  passkey_check_ends_sessions: boolean;
  org_deletion_passphrase_hash: string | null;
  updated_at?: string;
  updated_by?: string | null;
};
let settings: SettingsRow | null = null;
let settingsReadError: { message: string; code?: string } | null = null;
/** Each settings read answers the next of these first (then settingsReadError). */
let settingsReadQueue: Array<{ message: string } | null> = [];
/**
 * Each settings write answers the next of these (default: success). `landed`:
 * the write committed but its answer was an error (a lost response).
 */
let settingsWriteErrors: Array<{ message: string; code?: string; landed?: boolean } | null> = [];
let switches = new Set<string>();
/** When each organization's row says it was switched on (default: long ago). */
let switchedOnAt = new Map<string, string>();
let switchReadError: { message: string } | null = null;
/** Each switch read answers the next of these first (then switchReadError). */
let switchReadQueue: Array<{ message: string } | null> = [];
let switchWriteError: { message: string; code?: string; landed?: boolean } | null = null;
let switchDeleteErrors: Array<{ message: string } | null> = [];
let orgs: Array<{ id: string; name: string }> = [];
let orgReadError: { message: string } | null = null;
let members: Array<Record<string, unknown>> = [];
let passkeys: Array<Record<string, unknown>> = [];
let membersReadError: { message: string } | null = null;
/** Another admin's press landing between this press's read and its write. */
let beforeWrite: (() => void) | null = null;

/** The order of the audit rows and the switch writes in one press. */
const order: string[] = [];

const NO_SETTINGS_ROW: SettingsRow = {
  id: true,
  passkeys_on: false,
  passkey_adds_on: false,
  passkey_check_ends_sessions: false,
  org_deletion_passphrase_hash: null,
};

/** A timestamp as Postgres answers it (microseconds, +00:00), not as it was sent. */
function asStored(at: unknown): unknown {
  return typeof at === 'string' ? new Date(at).toISOString().replace('Z', '000+00:00') : at;
}

/** Every `.eq(column, value)` of a chain. */
function eqFilters(call: MockCall): Array<[string, unknown]> {
  return call.methods.flatMap((m, i) => (m === 'eq' ? [call.args[i] as [string, unknown]] : []));
}

/**
 * platform_settings as PostgREST would answer it: an insert of a row that
 * exists is a 23505, an upsert merges, an update changes the row only when
 * every `.eq` still matches and returns the rows it changed when asked.
 */
function writeSettings(call: MockCall) {
  order.push('write');
  beforeWrite?.();
  const err = settingsWriteErrors.shift() ?? null;
  if (err && !err.landed) return { data: null, error: err };
  let data: unknown = null;
  if (call.op === 'update') {
    const values = callArgs(call, 'update')?.[0] as Partial<SettingsRow>;
    const row = settings;
    const matches =
      row !== null &&
      eqFilters(call).every(([c, v]) => (row as unknown as Record<string, unknown>)[c] === v);
    if (matches)
      settings = { ...row, ...values, updated_at: asStored(values.updated_at) } as SettingsRow;
    if (call.methods.includes('select')) data = matches ? [{ id: true }] : [];
  } else {
    const upsert = call.methods.includes('upsert');
    const values = callArgs(call, upsert ? 'upsert' : 'insert')?.[0] as Partial<SettingsRow>;
    if (!upsert && settings !== null) {
      return {
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "platform_settings_pkey"',
          code: '23505',
        },
      };
    }
    settings = {
      ...(settings ?? NO_SETTINGS_ROW),
      ...values,
      updated_at: asStored(values.updated_at),
    } as SettingsRow;
  }
  return err ? { data: null, error: err } : { data, error: null };
}

const adminStub = makeSupabaseStub({
  'platform_settings.select': () => {
    const queued = settingsReadQueue.length > 0 ? settingsReadQueue.shift() : settingsReadError;
    return queued ? { data: null, error: queued } : { data: settings, error: null };
  },
  'platform_settings.insert': writeSettings,
  'platform_settings.update': writeSettings,
  'organizations.select': (call) =>
    orgReadError ? { data: null, error: orgReadError } : servedLikePostgrest(orgs)(call),
  'organization_passkey_switches.select': (call) => {
    const queued = switchReadQueue.length > 0 ? switchReadQueue.shift() : switchReadError;
    return queued
      ? { data: null, error: queued }
      : servedLikePostgrest(
          [...switches].map((organization_id) => ({
            organization_id,
            switched_on_at: switchedOnAt.get(organization_id) ?? '2026-01-01T00:00:00+00:00',
          })),
        )(call);
  },
  'organization_passkey_switches.insert': (call) => {
    order.push('write');
    beforeWrite?.();
    if (switchWriteError && !switchWriteError.landed)
      return { data: null, error: switchWriteError };
    const row = callArgs(call, 'insert')?.[0] as {
      organization_id: string;
      switched_on_at?: string;
    };
    switches.add(row.organization_id);
    if (row.switched_on_at)
      switchedOnAt.set(row.organization_id, asStored(row.switched_on_at) as string);
    return { data: null, error: switchWriteError };
  },
  'organization_passkey_switches.delete': (call) => {
    order.push('write');
    beforeWrite?.();
    const err = switchDeleteErrors.shift() ?? null;
    if (err) return { data: null, error: err };
    const eq = callArgs(call, 'eq') as [string, string];
    const removed =
      eq?.[0] === 'organization_id' && switches.delete(eq[1]) ? [{ organization_id: eq[1] }] : [];
    return { data: call.methods.includes('select') ? removed : null, error: null };
  },
  'organization_members.select': (call) =>
    membersReadError ? { data: null, error: membersReadError } : servedLikePostgrest(members)(call),
  'member_passkeys.select': (call) => servedLikePostgrest(passkeys)(call),
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return adminStub.client;
  },
}));

import {
  setNewPasskeysSwitchAction,
  setOrganizationPasskeysAction,
  setPasskeysKillSwitchAction,
} from './passkeys';

/** Every write any test could see, so "nothing written" is one number. */
function writes(): number {
  return (
    (adminStub.chainsAll.get('platform_settings.insert')?.length ?? 0) +
    (adminStub.chainsAll.get('platform_settings.update')?.length ?? 0) +
    (adminStub.chainsAll.get('organization_passkey_switches.insert')?.length ?? 0) +
    (adminStub.chainsAll.get('organization_passkey_switches.delete')?.length ?? 0)
  );
}
function reads(): number {
  return adminStub.fromCalls.length;
}
/** The values of the last insert (or upsert) of the settings row. */
function lastSettingsInsert(): Record<string, unknown> | undefined {
  const all = adminStub.chainArgsAll.get('platform_settings.insert') ?? [];
  const last = all[all.length - 1];
  return last?.[0]?.[0] as Record<string, unknown> | undefined;
}
function settingsReads(): number {
  return adminStub.chainsAll.get('platform_settings.select')?.length ?? 0;
}
function onRow(over: Partial<SettingsRow> = {}): SettingsRow {
  return { ...NO_SETTINGS_ROW, ...over };
}
function member(userId: string, organizationId: string, over: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    organization_id: organizationId,
    accepted_at: '2026-01-01T00:00:00Z',
    impersonation_expires_at: null,
    ...over,
  };
}

const RESULTS = [
  [
    'setPasskeysKillSwitchAction',
    (on: boolean, confirm: string) => setPasskeysKillSwitchAction({ on, confirm }),
  ],
  [
    'setNewPasskeysSwitchAction',
    (on: boolean, confirm: string) => setNewPasskeysSwitchAction({ on, confirm }),
  ],
  [
    'setOrganizationPasskeysAction',
    (on: boolean, confirm: string) =>
      setOrganizationPasskeysAction({ organizationId: ORG, on, confirm }),
  ],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.gate.mockImplementation(async () => ({
    ok: true,
    session: ADMIN,
    verifiedEmail: VERIFIED_EMAIL,
    verifiedUserId: ADMIN.userId,
  }));
  order.length = 0;
  h.recordPlatformAudit.mockImplementation(async () => {
    order.push('audit');
    return true;
  });
  h.adminThrows = false;
  settings = null;
  settingsReadError = null;
  settingsReadQueue = [];
  settingsWriteErrors = [];
  beforeWrite = null;
  switches = new Set();
  switchedOnAt = new Map();
  switchReadError = null;
  switchReadQueue = [];
  switchWriteError = null;
  switchDeleteErrors = [];
  orgs = [
    { id: ORG, name: 'Example Academy' },
    { id: OTHER_ORG, name: 'Sample Schools' },
  ];
  orgReadError = null;
  members = [];
  passkeys = [];
  membersReadError = null;
  adminStub.fromCalls.length = 0;
  adminStub.chainsAll.clear();
  adminStub.chainArgsAll.clear();
});

describe('every passkey switch: who may press it', () => {
  for (const [name, press] of RESULTS) {
    describe(name, () => {
      it('asks the platform-admin gate first, with a fresh step-up', async () => {
        await press(true, 'PASSKEYS');
        expect(h.gate).toHaveBeenCalledTimes(1);
        expect(h.gate).toHaveBeenCalledWith({ requireStepUp: true });
      });

      it('refuses a session that is not a platform admin, before anything is read or written', async () => {
        h.gate.mockImplementation(async () => ({ ok: false, reason: 'forbidden' }));
        const res = await press(true, 'PASSKEYS');
        expect(res).toEqual({
          ok: false,
          error: { code: 'forbidden', message: 'Not authorized.' },
        });
        expect(reads()).toBe(0);
        expect(writes()).toBe(0);
        expect(h.recordPlatformAudit).not.toHaveBeenCalled();
      });

      it('refuses without a fresh step-up, with the reason the step-up dialog reads, and touches nothing', async () => {
        h.gate.mockImplementation(async () => ({ ok: false, reason: 'aal2_required' }));
        const res = await press(true, 'PASSKEYS');
        expect(res).toEqual({
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Re-authenticate with MFA to change passkeys.',
            details: { reason: 'aal2_required' },
          },
        });
        expect(reads()).toBe(0);
        expect(writes()).toBe(0);
        expect(h.recordPlatformAudit).not.toHaveBeenCalled();
      });

      it('refuses when the id Auth verified is not the session id, before anything is read or written', async () => {
        h.gate.mockImplementation(async () => ({
          ok: true,
          session: ADMIN,
          verifiedEmail: VERIFIED_EMAIL,
          verifiedUserId: '0a000000-0000-4000-8000-0000000000ff',
        }));
        const res = await press(true, 'PASSKEYS');
        expect(res).toEqual({
          ok: false,
          error: { code: 'forbidden', message: 'Not authorized.' },
        });
        expect(reads()).toBe(0);
        expect(writes()).toBe(0);
        expect(h.recordPlatformAudit).not.toHaveBeenCalled();
        expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
      });

      it('refuses a gate answer with no verified id, and touches nothing', async () => {
        h.gate.mockImplementation(async () => ({
          ok: true,
          session: ADMIN,
          verifiedEmail: VERIFIED_EMAIL,
        }));
        const res = await press(true, 'PASSKEYS');
        expect(res.ok).toBe(false);
        expect(reads()).toBe(0);
        expect(writes()).toBe(0);
        expect(h.recordPlatformAudit).not.toHaveBeenCalled();
      });

      for (const word of [
        '',
        'passkeys',
        'Passkeys',
        'PASSKEY',
        ' PASSKEYS',
        'PASSKEYS ',
        'PASSKEYSX',
        'yes',
      ]) {
        it(`refuses the typed word ${JSON.stringify(word)} and touches nothing`, async () => {
          const res = await press(true, word);
          expect(res).toEqual({
            ok: false,
            error: { code: 'validation_error', message: 'Type PASSKEYS to confirm.' },
          });
          expect(reads()).toBe(0);
          expect(writes()).toBe(0);
          expect(h.recordPlatformAudit).not.toHaveBeenCalled();
        });
      }

      it('refuses input that is not a yes or no, and touches nothing', async () => {
        const res = await (name === 'setOrganizationPasskeysAction'
          ? setOrganizationPasskeysAction({
              organizationId: ORG,
              on: 'true' as unknown as boolean,
              confirm: 'PASSKEYS',
            })
          : name === 'setPasskeysKillSwitchAction'
            ? setPasskeysKillSwitchAction({ on: 1 as unknown as boolean, confirm: 'PASSKEYS' })
            : setNewPasskeysSwitchAction({ on: null as unknown as boolean, confirm: 'PASSKEYS' }));
        expect(res).toEqual({
          ok: false,
          error: { code: 'validation_error', message: 'Invalid input.' },
        });
        expect(writes()).toBe(0);
      });

      it('says the feature is not set up when the service client cannot be made, and writes nothing', async () => {
        h.adminThrows = true;
        const res = await press(true, 'PASSKEYS');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.message).toBe('This feature is not set up yet.');
        expect(writes()).toBe(0);
        expect(h.recordPlatformAudit).not.toHaveBeenCalled();
      });
    });
  }
});

describe.each([
  ['setPasskeysKillSwitchAction', 'passkeys_on', setPasskeysKillSwitchAction],
  ['setNewPasskeysSwitchAction', 'passkey_adds_on', setNewPasskeysSwitchAction],
] as const)('%s (platform_settings.%s)', (_name, column, action) => {
  const other = column === 'passkeys_on' ? 'passkey_adds_on' : 'passkeys_on';

  it('turns it on when the settings row does not exist: an insert of the one row with only this column', async () => {
    settings = null;
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    const values = lastSettingsInsert()!;
    expect(values).toMatchObject({ id: true, [column]: true, updated_by: ADMIN.userId });
    expect(Object.keys(values).sort()).toEqual(['id', column, 'updated_at', 'updated_by'].sort());
    expect(settings).toMatchObject({ [column]: true, [other]: false });
  });

  it('keeps the other settings and the deletion passphrase of an existing row', async () => {
    settings = {
      id: true,
      passkeys_on: false,
      passkey_adds_on: false,
      passkey_check_ends_sessions: true,
      org_deletion_passphrase_hash: 'stored-digest',
    };
    settings[other] = true;
    await action({ on: true, confirm: 'PASSKEYS' });
    expect(settings).toMatchObject({
      [column]: true,
      [other]: true,
      passkey_check_ends_sessions: true,
      org_deletion_passphrase_hash: 'stored-digest',
    });
  });

  it('an existing row is updated in place: only this column, on the one row, and only while it still holds the value read', async () => {
    settings = onRow({ org_deletion_passphrase_hash: 'stored-digest' });
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    expect(adminStub.chainsAll.get('platform_settings.insert')).toBeUndefined();
    const methods = adminStub.chainsAll.get('platform_settings.update')?.[0];
    const args = adminStub.chainArgsAll.get('platform_settings.update')?.[0];
    expect(methods?.[0]).toBe('update');
    const values = args?.[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(values).sort()).toEqual([column, 'updated_at', 'updated_by'].sort());
    expect(values).toMatchObject({ [column]: true, updated_by: ADMIN.userId });
    const eqs = methods!.flatMap((m, i) => (m === 'eq' ? [args![i]] : []));
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['id', true],
        [column, false],
      ]),
    );
    expect(eqs).toHaveLength(2);
    expect(methods).toContain('select');
  });

  it('turning ON: another admin turned it on between the read and the write: nothing done, the answer says so, and its record is marked not applied', async () => {
    settings = onRow();
    beforeWrite = () => {
      settings = onRow({ [column]: true });
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'Someone else changed this passkey switch at the same moment, so nothing was done. Check its state and try again.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(2);
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith({
      actorUserId: ADMIN.userId,
      actorEmail: VERIFIED_EMAIL,
      action: 'passkeys_switched',
      detail: { setting: column, from: false, to: true, not_applied: true },
    });
  });

  it('turning OFF: another admin turned it off between the read and the write: nothing done, the answer says so, and nothing recorded', async () => {
    settings = onRow({ passkeys_on: true, passkey_adds_on: true });
    beforeWrite = () => {
      settings = onRow({ passkeys_on: true, passkey_adds_on: true, [column]: false });
    };
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'Someone else changed this passkey switch at the same moment, so nothing was done. Check its state and try again.',
      },
    });
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('turning ON with no row, when another admin made the row first: switched only while it still holds the value read', async () => {
    settings = null;
    beforeWrite = () => {
      settings = onRow({ [other]: true, org_deletion_passphrase_hash: 'stored-digest' });
      beforeWrite = null;
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    expect(settings).toMatchObject({
      [column]: true,
      [other]: true,
      org_deletion_passphrase_hash: 'stored-digest',
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
  });

  it('turning ON with no row, when another admin made the row already on: nothing done, and its record is marked not applied', async () => {
    settings = null;
    beforeWrite = () => {
      settings = onRow({ [column]: true });
      beforeWrite = null;
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('conflict');
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: { setting: column, from: false, to: true, not_applied: true },
      }),
    );
  });

  it('turning ON: a write that answers an error but did land is read again: on, so its record is not marked not applied', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset', landed: true }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    expect(settings![column]).toBe(true);
    expect(settingsReads()).toBe(2);
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: `actions.platform.passkeys.${column}.write` }),
    );
  });

  it('turning ON: a write that fails, and the read again finds it on by another press: not credited, and it could not be confirmed', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset' }];
    beforeWrite = () => {
      settings = onRow({
        [column]: true,
        updated_by: '0a000000-0000-4000-8000-0000000000ee',
        updated_at: '2026-11-22T07:00:00.000+00:00',
      });
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: `actions.platform.passkeys.${column}.write_unconfirmed`,
      level: 'error',
      extra: { setting: column, to: true },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
  });

  it('turning ON: a write that fails, and the read again finds it on by this admin at another moment: not credited', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset' }];
    beforeWrite = () => {
      settings = onRow({
        [column]: true,
        updated_by: ADMIN.userId,
        updated_at: '2026-11-22T06:00:00.000+00:00',
      });
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(
        'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      );
    }
  });

  it("turning ON: the read again finds another actor's ON at this press's very instant: not credited", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-22T07:00:00.000Z'));
      settings = onRow();
      settingsWriteErrors = [{ message: 'connection reset' }];
      beforeWrite = () => {
        settings = onRow({
          [column]: true,
          updated_by: '0a000000-0000-4000-8000-0000000000ee',
          updated_at: '2026-11-22T07:00:00.000000+00:00',
        });
      };
      const res = await action({ on: true, confirm: 'PASSKEYS' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toBe(
          'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('turning ON: the read again finds a time that does not parse: not credited', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset' }];
    beforeWrite = () => {
      settings = onRow({ [column]: true, updated_by: ADMIN.userId, updated_at: 'not a time' });
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(
        'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      );
    }
  });

  it("turning ON: a write that answers an error but did land is confirmed by this press's own actor and timestamp, in the database's form", async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset', landed: true }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    const sent = adminStub.chainArgsAll.get('platform_settings.update')?.[0]?.[0]?.[0] as {
      updated_at: string;
    };
    // Stored as Postgres answers it, not as sent: the same instant.
    expect(settings!.updated_at).not.toBe(sent.updated_at);
    expect(Date.parse(settings!.updated_at!)).toBe(Date.parse(sent.updated_at));
    expect(settings!.updated_by).toBe(ADMIN.userId);
  });

  it('turning ON: a write that fails is read again before its record is marked not applied', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset' }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    expect(settingsReads()).toBe(2);
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: { setting: column, from: false, to: true, not_applied: true },
      }),
    );
  });

  it('turning ON: a write that fails and cannot be read again leaves its record unmarked, reports at error level, and says it could not tell', async () => {
    settings = onRow();
    settingsWriteErrors = [{ message: 'connection reset' }];
    settingsReadQueue = [null, { message: 'canceling statement due to statement timeout' }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: `actions.platform.passkeys.${column}.write_unconfirmed`,
      level: 'error',
      extra: { setting: column, to: true },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
  });

  it('reads the one settings row by its key', async () => {
    await action({ on: true, confirm: 'PASSKEYS' });
    const read = adminStub.chainArgsAll.get('platform_settings.select')?.[0];
    const methods = adminStub.chainsAll.get('platform_settings.select')?.[0];
    expect(methods).toContain('eq');
    expect(read?.[methods!.indexOf('eq')]).toEqual(['id', true]);
  });

  it('writes one audit row, passkeys_switched, with the setting and { from, to }', async () => {
    await action({ on: true, confirm: 'PASSKEYS' });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: ADMIN.userId,
      actorEmail: VERIFIED_EMAIL,
      action: 'passkeys_switched',
      detail: { setting: column, from: false, to: true },
    });
  });

  it('turns it off: an audit row { from: true, to: false }', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: false, changed: true, recorded: true } });
    expect(settings![column]).toBe(false);
    expect(settings![other]).toBe(true);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'passkeys_switched',
        detail: { setting: column, from: true, to: false },
      }),
    );
  });

  it('a press that changes nothing writes nothing and records nothing (no row is off)', async () => {
    settings = null;
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: false, changed: false, recorded: false } });
    expect(writes()).toBe(0);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('a press that changes nothing (already on) writes nothing and records nothing', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, recorded: false } });
    expect(writes()).toBe(0);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('a settings read that fails refuses, reports, and writes nothing (never read as "off")', async () => {
    settingsReadError = { message: 'canceling statement due to statement timeout', code: '57014' };
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not read the passkey switches, so nothing was changed. Try again.',
      },
    });
    expect(writes()).toBe(0);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('records first, then writes: the audit row lands before the switch changes', async () => {
    await action({ on: true, confirm: 'PASSKEYS' });
    expect(order).toEqual(['audit', 'write']);
  });

  it('turning ON: an audit row that cannot be written refuses, and nothing is switched', async () => {
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not record the change in the platform audit, so nothing was switched. Try again.',
      },
    });
    expect(writes()).toBe(0);
    expect(settings).toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: `actions.platform.passkeys.${column}.not_recorded` }),
    );
  });

  it('turning OFF: switched first, then recorded', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    await action({ on: false, confirm: 'PASSKEYS' });
    expect(order).toEqual(['write', 'audit']);
  });

  it('turning OFF: an audit row that cannot be written never holds it back; reported at error level with ids only, and the answer says so', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: false, changed: true, recorded: false } });
    expect(settings![column]).toBe(false);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: `actions.platform.passkeys.${column}.off_not_recorded`,
      level: 'error',
      extra: { setting: column, to: false },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
  });

  it('turning OFF: a write that fails is refused and records nothing', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    settingsWriteErrors = [{ message: 'connection reset' }];
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('a write that fails after its record refuses, reports, and marks the record not applied', async () => {
    settingsWriteErrors = [{ message: 'connection reset' }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not change the passkey switch, so nothing was changed. Try again.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(2);
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith({
      actorUserId: ADMIN.userId,
      actorEmail: VERIFIED_EMAIL,
      action: 'passkeys_switched',
      detail: { setting: column, from: false, to: true, not_applied: true },
    });
    expect(order).toEqual(['audit', 'write', 'audit']);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('a not-applied mark that cannot be written is reported too', async () => {
    settingsWriteErrors = [{ message: 'connection reset' }];
    let calls = 0;
    h.recordPlatformAudit.mockImplementation(async () => ++calls === 1);
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res.ok).toBe(false);
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it("the actor's email is the one Auth verified, never the session's profile column", async () => {
    await action({ on: true, confirm: 'PASSKEYS' });
    expect(h.recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmail: VERIFIED_EMAIL }),
    );
    expect(h.recordPlatformAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ actorEmail: ADMIN.email }),
    );
  });
});

describe('setOrganizationPasskeysAction', () => {
  it('turns an organization on: inserts its switch row and writes org_passkeys_switched { from, to }', async () => {
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    expect([...switches]).toEqual([ORG]);
    expect(adminStub.chainsAll.get('organization_passkey_switches.insert')).toEqual([['insert']]);
    const inserted = adminStub.chainArgsAll.get('organization_passkey_switches.insert')?.[0]?.[0];
    // The press's own timestamp, sent by the action (never the database's default).
    expect(inserted).toEqual([{ organization_id: ORG, switched_on_at: expect.any(String) }]);
    const at = (inserted?.[0] as { switched_on_at: string }).switched_on_at;
    expect(new Date(at).toISOString()).toBe(at);
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: ADMIN.userId,
      actorEmail: VERIFIED_EMAIL,
      action: 'org_passkeys_switched',
      targetOrganizationId: ORG,
      detail: { from: false, to: true },
    });
  });

  it('turns an organization off: deletes only its row, records { from: true, to: false }, and counts who still holds a passkey', async () => {
    switches = new Set([ORG, OTHER_ORG]);
    members = [
      member(U1, ORG),
      member(U2, ORG),
      member(U3, ORG),
      // an invitation not accepted, an act-as seat, a member of another organization: not counted
      member(U4, ORG, { accepted_at: null }),
      member(U4, ORG, { impersonation_expires_at: '2026-12-01T00:00:00Z' }),
      member(U4, OTHER_ORG),
    ];
    passkeys = [
      // U1 holds two: counted once
      { user_id: U1, removed_at: null },
      { user_id: U1, removed_at: null },
      // U2's only passkey was removed: not counted
      { user_id: U2, removed_at: '2026-11-01T00:00:00Z' },
      { user_id: U3, removed_at: null },
      { user_id: U4, removed_at: null },
    ];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: true, recorded: true, membersWithPasskeys: 2 },
    });
    expect([...switches]).toEqual([OTHER_ORG]);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_passkeys_switched',
        targetOrganizationId: ORG,
        detail: { from: true, to: false },
      }),
    );
  });

  it('an organization off with no passkey holders answers 0', async () => {
    switches = new Set([ORG]);
    members = [member(U1, ORG)];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: true, recorded: true, membersWithPasskeys: 0 },
    });
  });

  it('a count that cannot be read still turns it off, answers null, and reports', async () => {
    switches = new Set([ORG]);
    membersReadError = { message: 'connection reset' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: true, recorded: true, membersWithPasskeys: null },
    });
    expect(switches.size).toBe(0);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('already off: nothing written or recorded, and the count is still answered', async () => {
    members = [member(U1, ORG)];
    passkeys = [{ user_id: U1, removed_at: null }];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: false, recorded: false, membersWithPasskeys: 1 },
    });
    expect(writes()).toBe(0);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('already on: nothing written or recorded', async () => {
    switches = new Set([ORG]);
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, recorded: false } });
    expect(writes()).toBe(0);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('an id that is not a uuid is refused before anything is read', async () => {
    const res = await setOrganizationPasskeysAction({
      organizationId: 'not-a-uuid',
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'Invalid input.' },
    });
    expect(reads()).toBe(0);
  });

  it('an organization that does not exist is not found, and nothing is written', async () => {
    const res = await setOrganizationPasskeysAction({
      organizationId: '0b000000-0000-4000-8000-0000000000ff',
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Organization not found.' },
    });
    expect(writes()).toBe(0);
  });

  it('an organization read that fails refuses (never "not found"), and nothing is written', async () => {
    orgReadError = { message: 'connection reset' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not read the organization, so nothing was changed. Try again.',
      },
    });
    expect(writes()).toBe(0);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('a switch read that fails refuses and writes nothing', async () => {
    switchReadError = { message: 'connection reset' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not read the passkey switches, so nothing was changed. Try again.',
      },
    });
    expect(writes()).toBe(0);
  });

  it('a row another admin inserted first (23505) is "already on", and its record is marked not applied', async () => {
    switchWriteError = { message: 'duplicate key value violates unique constraint', code: '23505' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, recorded: false } });
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { from: false, to: true, not_applied: true } }),
    );
  });

  it('records first, then writes', async () => {
    await setOrganizationPasskeysAction({ organizationId: ORG, on: true, confirm: 'PASSKEYS' });
    expect(order).toEqual(['audit', 'write']);
  });

  it('an insert that fails otherwise refuses and marks its record not applied', async () => {
    switchWriteError = { message: 'connection reset' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not change the passkey switch, so nothing was changed. Try again.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(2);
    expect(h.recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'org_passkeys_switched',
        targetOrganizationId: ORG,
        detail: { from: false, to: true, not_applied: true },
      }),
    );
    // read again before marking it: still off
    expect(adminStub.chainsAll.get('organization_passkey_switches.select')).toHaveLength(2);
  });

  it('an insert that answers an error but did land is read again: on, so its record is not marked not applied', async () => {
    switchWriteError = { message: 'connection reset', landed: true };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, recorded: true } });
    expect(switches.has(ORG)).toBe(true);
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'actions.platform.passkeys.organization.write' }),
    );
  });

  it('an insert that fails, and the read again finds a row another press made: not credited, and it could not be confirmed', async () => {
    switchWriteError = { message: 'connection reset' };
    beforeWrite = () => {
      switches.add(ORG);
      switchedOnAt.set(ORG, '2026-11-22T07:00:00.000+00:00');
    };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'actions.platform.passkeys.organization.write_unconfirmed',
      level: 'error',
      extra: { organizationId: ORG, to: true },
    });
  });

  it('an insert that fails and cannot be read again leaves its record unmarked, reports at error level, and says it could not tell', async () => {
    switchWriteError = { message: 'connection reset' };
    switchReadQueue = [null, { message: 'canceling statement due to statement timeout' }];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm whether the passkey switch changed. Reload the page to see its state.',
      },
    });
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'actions.platform.passkeys.organization.write_unconfirmed',
      level: 'error',
      extra: { organizationId: ORG, to: true },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
  });

  it('turning off: a delete that removes nothing (another admin turned it off first) answers no change and records nothing', async () => {
    switches = new Set([ORG]);
    members = [member(U1, ORG)];
    passkeys = [{ user_id: U1, removed_at: null }];
    beforeWrite = () => {
      switches.delete(ORG);
    };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: false, recorded: false, membersWithPasskeys: 1 },
    });
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('turning on: an audit row that cannot be written refuses, and nothing is switched', async () => {
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not record the change in the platform audit, so nothing was switched. Try again.',
      },
    });
    expect(writes()).toBe(0);
    expect(switches.has(ORG)).toBe(false);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('turning off: switched first, then recorded', async () => {
    switches = new Set([ORG]);
    await setOrganizationPasskeysAction({ organizationId: ORG, on: false, confirm: 'PASSKEYS' });
    expect(order).toEqual(['write', 'audit']);
  });

  it('turning off: an audit row that cannot be written never holds it back; reported at error level with ids only, and the answer says so', async () => {
    switches = new Set([ORG]);
    members = [member(U1, ORG)];
    passkeys = [{ user_id: U1, removed_at: null }];
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: true, recorded: false, membersWithPasskeys: 1 },
    });
    expect(switches.has(ORG)).toBe(false);
    expect(h.reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'actions.platform.passkeys.organization.off_not_recorded',
      level: 'error',
      extra: { organizationId: ORG, to: false },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('@');
  });

  it('turning off: a delete that fails is refused and records nothing', async () => {
    switches = new Set([ORG]);
    switchDeleteErrors = [{ message: 'connection reset' }];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not change the passkey switch, so nothing was changed. Try again.',
      },
    });
    expect(switches.has(ORG)).toBe(true);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('the delete names this organization only, and returns the rows it removed', async () => {
    switches = new Set([ORG]);
    await setOrganizationPasskeysAction({ organizationId: ORG, on: false, confirm: 'PASSKEYS' });
    const del = adminStub.chainArgsAll.get('organization_passkey_switches.delete')?.[0];
    const methods = adminStub.chainsAll.get('organization_passkey_switches.delete')?.[0];
    expect(methods).toEqual(['delete', 'eq', 'select']);
    expect(del?.[1]).toEqual(['organization_id', ORG]);
    expect(del?.[2]).toEqual(['organization_id']);
  });
});
