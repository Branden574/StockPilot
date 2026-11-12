import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the new-device email goes out once per new device, for
 * the device that really is new, and its webhook event reaches only the
 * organizations the person really belongs to (S5, plans/S5.md 3.4 step 12).
 *
 * THE DEFECTS.
 *  - The insert's answer was ignored and the email sent anyway, so two
 *    sign-ins racing on one new device each emailed (the second insert is
 *    refused by unique (user_id, device_hash), 0168), and a refused insert
 *    emailed about a device that was never recorded.
 *  - A device was its user agent with the version numbers taken out. Every
 *    iPhone's app agent reads alike, so a person's second phone was never
 *    new. The phone now sends a per-install id (deviceKey): one install is
 *    one device, two installs are two, an OS or app update is the same one.
 *  - The webhook event went to up to five organizations of ANY membership
 *    row: an invitation never accepted, or a support "act as" seat.
 *
 * The admin client is an in-memory table that keeps 0168's unique key.
 */

interface DeviceRow {
  id: string;
  user_id: string;
  device_hash: string;
  user_agent: string | null;
  last_ip: string | null;
}
interface MemberRow {
  user_id: string;
  organization_id: string;
  accepted_at: string | null;
  impersonation_expires_at: string | null;
}

const db = vi.hoisted(() => ({
  devices: [] as DeviceRow[],
  members: [] as MemberRow[],
  /** Forces the next insert's answer (a refusal the table would not give). */
  insertError: null as null | { code: string; message: string },
  nextId: 1,
}));

type Filter = ['eq' | 'is' | 'not', string, unknown];

function tableClient(name: 'user_login_devices' | 'organization_members') {
  const q = {
    op: 'select' as 'select' | 'insert' | 'update',
    head: false,
    payload: null as Record<string, unknown> | null,
    filters: [] as Filter[],
    limit: Infinity,
  };
  const rows = (): Array<Record<string, unknown>> =>
    (name === 'user_login_devices' ? db.devices : db.members) as unknown as Array<
      Record<string, unknown>
    >;
  const matches = (r: Record<string, unknown>) =>
    q.filters.every(([kind, col, value]) =>
      kind === 'eq'
        ? r[col] === value
        : kind === 'is'
          ? (r[col] ?? null) === value
          : (r[col] ?? null) !== value,
    );
  const run = (): { data: unknown; error: unknown; count?: number } => {
    if (q.op === 'insert') {
      if (db.insertError) {
        const error = db.insertError;
        db.insertError = null;
        return { data: null, error };
      }
      const p = q.payload as unknown as DeviceRow;
      if (db.devices.some((d) => d.user_id === p.user_id && d.device_hash === p.device_hash)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value' } };
      }
      db.devices.push({ ...p, id: `device-${db.nextId++}` });
      return { data: null, error: null };
    }
    if (q.op === 'update') {
      for (const r of rows().filter(matches)) Object.assign(r, q.payload);
      return { data: null, error: null };
    }
    const found = rows().filter(matches).slice(0, q.limit);
    return q.head ? { data: null, error: null, count: found.length } : { data: found, error: null };
  };
  const b = {
    select: (_cols: string, opts?: { head?: boolean }) => {
      q.head = opts?.head === true;
      return b;
    },
    insert: (payload: Record<string, unknown>) => {
      q.op = 'insert';
      q.payload = payload;
      return b;
    },
    update: (payload: Record<string, unknown>) => {
      q.op = 'update';
      q.payload = payload;
      return b;
    },
    eq: (col: string, value: unknown) => {
      q.filters.push(['eq', col, value]);
      return b;
    },
    is: (col: string, value: unknown) => {
      q.filters.push(['is', col, value]);
      return b;
    },
    not: (col: string, op: string, value: unknown) => {
      if (op !== 'is') throw new Error(`not(${op}) is not modelled`);
      q.filters.push(['not', col, value]);
      return b;
    },
    limit: (n: number) => {
      q.limit = n;
      return b;
    },
    maybeSingle: async () => {
      const r = run();
      return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(resolve, reject),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: 'user_login_devices' | 'organization_members') => tableClient(t),
  }),
}));
const sendNewDeviceLoginEmail = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => undefined),
);
vi.mock('@/lib/email/login-alert', () => ({ sendNewDeviceLoginEmail }));
const dispatchEvent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent }));
const reportError = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { noteLoginDevice } from './login-device';

const USER = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'member@example.com';
const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const APP_UA_1 = 'StockPilot/41 CFNetwork/1568.100.1 Darwin/24.0.0';
const APP_UA_2 = 'StockPilot/42 CFNetwork/1568.200.51 Darwin/24.1.0';
const INSTALL_1 = '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f';
const INSTALL_2 = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7d';
const LABEL = 'StockPilot app on iPhone 15 Pro (iOS 18.1)';
const FAMILY = 'StockPilot app on iPhone';

const phone = (deviceKey: string, userAgent = APP_UA_1, deviceLabel = LABEL) =>
  noteLoginDevice({
    userId: USER,
    email: EMAIL,
    userAgent,
    ip: '203.0.113.7',
    deviceKey,
    deviceLabel,
    deviceFamily: FAMILY,
  });
const web = () =>
  noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: '203.0.113.9' });

beforeEach(() => {
  db.devices = [];
  db.members = [];
  db.insertError = null;
  db.nextId = 1;
  sendNewDeviceLoginEmail.mockClear();
  dispatchEvent.mockClear();
  reportError.mockClear();
});

describe('noteLoginDevice — the email goes out only for a device this call recorded', () => {
  it('a 23505 on the insert (another sign-in recorded the device first) sends no email', async () => {
    await web();
    db.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    await phone(INSTALL_1);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('any other refused insert is reported, and sends no email', async () => {
    await web();
    db.insertError = { code: '57014', message: 'canceling statement due to statement timeout' };
    await phone(INSTALL_1);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'auth.login_device_note_failed',
      level: 'warning',
    });
  });

  it('the first device an account is ever seen on is recorded silently, as before', async () => {
    await phone(INSTALL_1);
    expect(db.devices).toHaveLength(1);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });
});

describe('noteLoginDevice — which device is new (the phone’s install id)', () => {
  it('one install is one device: hashed as `<user>::app::<install id>`', async () => {
    await phone(INSTALL_1);
    const expected = createHash('sha256')
      .update(`${USER}::app::${INSTALL_1}`)
      .digest('hex')
      .slice(0, 40);
    expect(db.devices[0]!.device_hash).toBe(expected);
  });

  it('two installs on the same model are two devices: the second one emails', async () => {
    await phone(INSTALL_1);
    await phone(INSTALL_2);
    expect(db.devices).toHaveLength(2);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
  });

  it('an OS update or an app update on the same install is the same device: no email', async () => {
    await web();
    await phone(INSTALL_1, APP_UA_1, LABEL);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    await phone(INSTALL_1, APP_UA_2, 'StockPilot app on iPhone 15 Pro (iOS 18.2)');
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(db.devices).toHaveLength(2);
  });

  it('with no key (the web, or a phone whose Keychain refused), the agent decides, as before', async () => {
    await web();
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: APP_UA_1, ip: null });
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: APP_UA_2, ip: null });
    // Version numbers do not make a new device.
    expect(db.devices).toHaveLength(2);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
  });
});

describe('noteLoginDevice — the label names the device to the person, the family to the organization', () => {
  it('the email and the stored agent use the label; the webhook’s device field only the family', async () => {
    db.members = [
      {
        user_id: USER,
        organization_id: 'org-a',
        accepted_at: '2026-01-01T00:00:00Z',
        impersonation_expires_at: null,
      },
    ];
    await web();
    await phone(INSTALL_1);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledWith({
      to: EMAIL,
      userAgent: APP_UA_1,
      ip: '203.0.113.7',
      deviceLabel: LABEL,
    });
    expect(db.devices[1]!.user_agent).toBe(LABEL);
    // Integrator decision (device label, 2026-11-02): the sign-in note keeps
    // only the device family in the organization's activity.
    expect(dispatchEvent).toHaveBeenCalledWith('org-a', 'security.new_device_login', {
      userId: USER,
      device: FAMILY,
    });
    expect(JSON.stringify(dispatchEvent.mock.calls)).not.toContain('15 Pro');
  });

  it('a known install’s row is refreshed with the label, not the raw agent', async () => {
    await phone(INSTALL_1, APP_UA_1, LABEL);
    await phone(INSTALL_1, APP_UA_2, 'StockPilot app on iPhone 15 Pro (iOS 18.2)');
    expect(db.devices[0]!.user_agent).toBe('StockPilot app on iPhone 15 Pro (iOS 18.2)');
  });
});

describe('noteLoginDevice — the webhook event reaches only real memberships (open question 19)', () => {
  it('an accepted membership: yes; an invitation never accepted or an act-as seat: no', async () => {
    db.members = [
      {
        user_id: USER,
        organization_id: 'org-real',
        accepted_at: '2026-01-01T00:00:00Z',
        impersonation_expires_at: null,
      },
      {
        user_id: USER,
        organization_id: 'org-invited',
        accepted_at: null,
        impersonation_expires_at: null,
      },
      {
        user_id: USER,
        organization_id: 'org-act-as',
        accepted_at: '2026-01-01T00:00:00Z',
        impersonation_expires_at: '2099-01-01T00:00:00Z',
      },
    ];
    await web();
    await phone(INSTALL_1);
    expect(dispatchEvent.mock.calls.map((c) => c[0])).toEqual(['org-real']);
  });
});
