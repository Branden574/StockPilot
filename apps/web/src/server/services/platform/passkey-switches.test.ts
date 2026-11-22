import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * The console's passkey reads (plan section 4). Pinned: no settings row is
 * everything off; a failed read is null (shown as unknown, never as off) and
 * reported; the organizations with passkeys on, newest first, with their
 * names and how many members (accepted, not act-as seats) hold an active
 * passkey; a name or count that could not be read is null for that column
 * only. Made-up ids.
 */

const ORG_A = '0b000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000002';
const U1 = '0c000000-0000-4000-8000-000000000001';
const U2 = '0c000000-0000-4000-8000-000000000002';
const U3 = '0c000000-0000-4000-8000-000000000003';

const h = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));

type Err = { message: string } | null;
let settings: Record<string, unknown> | null = null;
let settingsError: Err = null;
let switchRows: Array<Record<string, unknown>> = [];
let switchError: Err = null;
let orgRows: Array<Record<string, unknown>> = [];
let orgError: Err = null;
let members: Array<Record<string, unknown>> = [];
let passkeys: Array<Record<string, unknown>> = [];
let passkeyError: Err = null;

const stub = makeSupabaseStub({
  'platform_settings.select': () => ({ data: settings, error: settingsError }),
  'organization_passkey_switches.select': (call) =>
    switchError ? { data: null, error: switchError } : servedLikePostgrest(switchRows)(call),
  'organizations.select': (call) =>
    orgError ? { data: null, error: orgError } : servedLikePostgrest(orgRows)(call),
  'organization_members.select': (call) => servedLikePostgrest(members)(call),
  'member_passkeys.select': (call) =>
    passkeyError ? { data: null, error: passkeyError } : servedLikePostgrest(passkeys)(call),
});
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => stub.client }));

import {
  listOrganizationsForPasskeys,
  readOrganizationPasskeysOn,
  readPasskeyConsole,
} from './passkey-switches';

beforeEach(() => {
  vi.clearAllMocks();
  settings = null;
  settingsError = null;
  switchRows = [];
  switchError = null;
  orgRows = [
    { id: ORG_A, name: 'Example Academy' },
    { id: ORG_B, name: 'Sample Schools' },
  ];
  orgError = null;
  members = [];
  passkeys = [];
  passkeyError = null;
});

function member(id: string, userId: string, orgId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    organization_id: orgId,
    accepted_at: '2026-01-01T00:00:00Z',
    impersonation_expires_at: null,
    ...over,
  };
}

describe('readPasskeyConsole', () => {
  it('no settings row: both switches off, and the row is said to be missing', async () => {
    const state = await readPasskeyConsole();
    expect(state.switches).toEqual({ passkeysOn: false, passkeyAddsOn: false, rowExists: false });
    expect(state.organizations).toEqual([]);
  });

  it('reads the row as it is; anything but true is off', async () => {
    settings = { passkeys_on: true, passkey_adds_on: 'yes' };
    const state = await readPasskeyConsole();
    expect(state.switches).toEqual({ passkeysOn: true, passkeyAddsOn: false, rowExists: true });
  });

  it('a settings read that fails is null and reported', async () => {
    settingsError = { message: 'connection reset' };
    const state = await readPasskeyConsole();
    expect(state.switches).toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform.passkeys.read_settings' }),
    );
  });

  it('lists the organizations with passkeys on, newest first, with names and passkey holders counted', async () => {
    switchRows = [
      { organization_id: ORG_A, switched_on_at: '2026-11-19T09:00:00Z' },
      { organization_id: ORG_B, switched_on_at: '2026-11-20T09:00:00Z' },
    ];
    members = [
      member('m1', U1, ORG_A),
      member('m2', U2, ORG_A),
      member('m3', U3, ORG_A, { accepted_at: null }),
      member('m4', U3, ORG_B, { impersonation_expires_at: '2026-12-01T00:00:00Z' }),
      member('m5', U1, ORG_B),
    ];
    passkeys = [
      { id: 'p1', user_id: U1, removed_at: null },
      { id: 'p2', user_id: U2, removed_at: '2026-11-01T00:00:00Z' },
      { id: 'p3', user_id: U3, removed_at: null },
    ];
    const state = await readPasskeyConsole();
    expect(state.organizations).toEqual([
      {
        id: ORG_B,
        name: 'Sample Schools',
        switchedOnAt: '2026-11-20T09:00:00Z',
        membersWithPasskeys: 1,
      },
      {
        id: ORG_A,
        name: 'Example Academy',
        switchedOnAt: '2026-11-19T09:00:00Z',
        membersWithPasskeys: 1,
      },
    ]);
  });

  it('a count that cannot be read is null for every row, the rows still listed', async () => {
    switchRows = [{ organization_id: ORG_A, switched_on_at: '2026-11-19T09:00:00Z' }];
    members = [member('m1', U1, ORG_A)];
    passkeyError = { message: 'connection reset' };
    const state = await readPasskeyConsole();
    expect(state.organizations).toEqual([
      {
        id: ORG_A,
        name: 'Example Academy',
        switchedOnAt: '2026-11-19T09:00:00Z',
        membersWithPasskeys: null,
      },
    ]);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform.passkeys.count_holders' }),
    );
  });

  it('names that cannot be read are null, the rows still listed', async () => {
    switchRows = [{ organization_id: ORG_A, switched_on_at: '2026-11-19T09:00:00Z' }];
    orgError = { message: 'connection reset' };
    const state = await readPasskeyConsole();
    expect(state.organizations?.[0]).toMatchObject({
      id: ORG_A,
      name: null,
      membersWithPasskeys: 0,
    });
  });

  it('a switch-row read that fails is null and reported', async () => {
    switchError = { message: 'connection reset' };
    const state = await readPasskeyConsole();
    expect(state.organizations).toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform.passkeys.read_switches' }),
    );
  });
});

describe('listOrganizationsForPasskeys', () => {
  it('every organization by name', async () => {
    orgRows = [
      { id: ORG_B, name: 'Sample Schools' },
      { id: ORG_A, name: 'Example Academy' },
    ];
    expect(await listOrganizationsForPasskeys()).toEqual({
      organizations: [
        { id: ORG_A, name: 'Example Academy' },
        { id: ORG_B, name: 'Sample Schools' },
      ],
      capped: false,
    });
  });

  it('a failed read is null and reported', async () => {
    orgError = { message: 'connection reset' };
    expect(await listOrganizationsForPasskeys()).toBeNull();
    expect(h.reportError).toHaveBeenCalled();
  });
});

describe('readOrganizationPasskeysOn', () => {
  it('true with a row, false without, null when the read fails', async () => {
    switchRows = [{ organization_id: ORG_A, switched_on_at: '2026-11-19T09:00:00Z' }];
    expect(await readOrganizationPasskeysOn(ORG_A)).toBe(true);
    expect(await readOrganizationPasskeysOn(ORG_B)).toBe(false);
    switchError = { message: 'connection reset' };
    expect(await readOrganizationPasskeysOn(ORG_A)).toBeNull();
  });
});
