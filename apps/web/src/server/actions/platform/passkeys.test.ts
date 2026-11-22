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
 * changed nothing; an ON whose audit row does not land is switched back off;
 * an OFF stands without it and says so; an organization turned off answers
 * how many of its members still hold an active passkey.
 *
 * Made-up ids and addresses only.
 */

const ADMIN = { userId: '0a000000-0000-4000-8000-000000000001', email: 'operator@example.test' };
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
};
let settings: SettingsRow | null = null;
let settingsReadError: { message: string; code?: string } | null = null;
/** Each upsert answers the next of these (default: success). */
let upsertErrors: Array<{ message: string } | null> = [];
let switches = new Set<string>();
let switchReadError: { message: string } | null = null;
let switchWriteError: { message: string; code?: string } | null = null;
let switchDeleteErrors: Array<{ message: string } | null> = [];
let orgs: Array<{ id: string; name: string }> = [];
let orgReadError: { message: string } | null = null;
let members: Array<Record<string, unknown>> = [];
let passkeys: Array<Record<string, unknown>> = [];
let membersReadError: { message: string } | null = null;

function upsertSettings(call: MockCall) {
  const err = upsertErrors.shift() ?? null;
  if (err) return { data: null, error: err };
  const values = callArgs(call, 'upsert')?.[0] as Partial<SettingsRow> & Record<string, unknown>;
  settings = {
    ...(settings ?? {
      id: true,
      passkeys_on: false,
      passkey_adds_on: false,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    }),
    ...values,
  } as SettingsRow;
  return { data: null, error: null };
}

const adminStub = makeSupabaseStub({
  'platform_settings.select': () =>
    settingsReadError ? { data: null, error: settingsReadError } : { data: settings, error: null },
  'platform_settings.insert': upsertSettings,
  'organizations.select': (call) =>
    orgReadError ? { data: null, error: orgReadError } : servedLikePostgrest(orgs)(call),
  'organization_passkey_switches.select': (call) =>
    switchReadError
      ? { data: null, error: switchReadError }
      : servedLikePostgrest([...switches].map((organization_id) => ({ organization_id })))(call),
  'organization_passkey_switches.insert': (call) => {
    if (switchWriteError) return { data: null, error: switchWriteError };
    const row = callArgs(call, 'insert')?.[0] as { organization_id: string };
    switches.add(row.organization_id);
    return { data: null, error: null };
  },
  'organization_passkey_switches.delete': (call) => {
    const err = switchDeleteErrors.shift() ?? null;
    if (err) return { data: null, error: err };
    const eq = callArgs(call, 'eq') as [string, string];
    if (eq?.[0] === 'organization_id') switches.delete(eq[1]);
    return { data: null, error: null };
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
function lastUpsert(): Record<string, unknown> | undefined {
  const all = adminStub.chainArgsAll.get('platform_settings.insert') ?? [];
  const last = all[all.length - 1];
  return last?.[0]?.[0] as Record<string, unknown> | undefined;
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
  h.gate.mockImplementation(async () => ({ ok: true, session: ADMIN }));
  h.recordPlatformAudit.mockImplementation(async () => true);
  h.adminThrows = false;
  settings = null;
  settingsReadError = null;
  upsertErrors = [];
  switches = new Set();
  switchReadError = null;
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
  ['setPasskeysKillSwitchAction', 'passkeys_on', setPasskeysKillSwitchAction, 'passkeys'],
  ['setNewPasskeysSwitchAction', 'passkey_adds_on', setNewPasskeysSwitchAction, 'new passkeys'],
] as const)('%s (platform_settings.%s)', (_name, column, action, leftOffWords) => {
  const other = column === 'passkeys_on' ? 'passkey_adds_on' : 'passkeys_on';

  it('turns it on when the settings row does not exist: an upsert of the one row with only this column', async () => {
    settings = null;
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, auditRecorded: true } });
    const values = lastUpsert()!;
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
      actorEmail: ADMIN.email,
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
    expect(res).toEqual({ ok: true, data: { on: false, changed: true, auditRecorded: true } });
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
    expect(res).toEqual({ ok: true, data: { on: false, changed: false, auditRecorded: false } });
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
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, auditRecorded: false } });
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

  it('a write that fails refuses, reports, and records nothing', async () => {
    upsertErrors = [{ message: 'connection reset' }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not change the passkey switch, so nothing was changed. Try again.',
      },
    });
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalled();
  });

  it('an ON whose audit row does not land is switched back off, reported, and refused', async () => {
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: `The change could not be recorded in the platform audit, so ${leftOffWords} were left off. Try again.`,
      },
    });
    expect(settings![column]).toBe(false);
    const upserts = adminStub.chainArgsAll.get('platform_settings.insert') ?? [];
    expect(upserts).toHaveLength(2);
    expect(upserts[1]?.[0]?.[0]).toMatchObject({ id: true, [column]: false });
    expect(h.reportError).toHaveBeenCalled();
  });

  it('an ON whose audit row does not land and whose switch-back fails says it may be on', async () => {
    h.recordPlatformAudit.mockImplementation(async () => false);
    upsertErrors = [null, { message: 'connection reset' }];
    const res = await action({ on: true, confirm: 'PASSKEYS' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'The change could not be recorded in the platform audit, and the switch may still be on. Reload this page and turn it off if it is.',
      },
    });
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it('an OFF stands when its audit row does not land: answered, with auditRecorded false, and reported', async () => {
    settings = {
      id: true,
      passkeys_on: true,
      passkey_adds_on: true,
      passkey_check_ends_sessions: false,
      org_deletion_passphrase_hash: null,
    };
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await action({ on: false, confirm: 'PASSKEYS' });
    expect(res).toEqual({ ok: true, data: { on: false, changed: true, auditRecorded: false } });
    expect(settings![column]).toBe(false);
    expect(adminStub.chainsAll.get('platform_settings.insert')).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalled();
  });
});

describe('setOrganizationPasskeysAction', () => {
  it('turns an organization on: inserts its switch row and writes org_passkeys_switched { from, to }', async () => {
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: true, auditRecorded: true } });
    expect([...switches]).toEqual([ORG]);
    expect(adminStub.chainsAll.get('organization_passkey_switches.insert')).toEqual([['insert']]);
    expect(adminStub.chainArgsAll.get('organization_passkey_switches.insert')?.[0]?.[0]).toEqual([
      { organization_id: ORG },
    ]);
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: ADMIN.userId,
      actorEmail: ADMIN.email,
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
      data: { on: false, changed: true, auditRecorded: true, membersWithPasskeys: 2 },
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
      data: { on: false, changed: true, auditRecorded: true, membersWithPasskeys: 0 },
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
      data: { on: false, changed: true, auditRecorded: true, membersWithPasskeys: null },
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
      data: { on: false, changed: false, auditRecorded: false, membersWithPasskeys: 1 },
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
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, auditRecorded: false } });
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

  it('a row another admin inserted first (23505) is "already on": nothing recorded', async () => {
    switchWriteError = { message: 'duplicate key value violates unique constraint', code: '23505' };
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({ ok: true, data: { on: true, changed: false, auditRecorded: false } });
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('an insert that fails otherwise refuses and records nothing', async () => {
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
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('an ON whose audit row does not land is switched back off (its row deleted) and refused', async () => {
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
          'The change could not be recorded in the platform audit, so passkeys were left off for this organization. Try again.',
      },
    });
    expect(switches.size).toBe(0);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('an ON whose audit row does not land and whose switch-back fails says it may be on', async () => {
    h.recordPlatformAudit.mockImplementation(async () => false);
    switchDeleteErrors = [{ message: 'connection reset' }];
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: true,
      confirm: 'PASSKEYS',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(
        'The change could not be recorded in the platform audit, and the switch may still be on. Reload this page and turn it off if it is.',
      );
    }
    expect(switches.has(ORG)).toBe(true);
  });

  it('an OFF stands when its audit row does not land, and says so through auditRecorded', async () => {
    switches = new Set([ORG]);
    h.recordPlatformAudit.mockImplementation(async () => false);
    const res = await setOrganizationPasskeysAction({
      organizationId: ORG,
      on: false,
      confirm: 'PASSKEYS',
    });
    expect(res).toEqual({
      ok: true,
      data: { on: false, changed: true, auditRecorded: false, membersWithPasskeys: 0 },
    });
    expect(switches.size).toBe(0);
  });

  it('a delete that fails refuses, records nothing', async () => {
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
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('the delete names this organization only', async () => {
    switches = new Set([ORG]);
    await setOrganizationPasskeysAction({ organizationId: ORG, on: false, confirm: 'PASSKEYS' });
    const del = adminStub.chainArgsAll.get('organization_passkey_switches.delete')?.[0];
    const methods = adminStub.chainsAll.get('organization_passkey_switches.delete')?.[0];
    expect(methods).toEqual(['delete', 'eq']);
    expect(del?.[1]).toEqual(['organization_id', ORG]);
  });
});
