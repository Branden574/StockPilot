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
 * PART 3 (sign-in alerts): the same call also notes the sign-in's country,
 * records each alert in sign_in_alerts before its email, and alerts for a new
 * country as well as a new device (one alert per sign-in, both flags). Its
 * cases are at the end of this file.
 *
 * The admin client is an in-memory model of the tables it writes, keeping
 * 0168's unique key and the sign_in_alerts and user_sign_in_countries keys
 * and checks of migration sign_in_alerts.
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
interface CountryRow {
  user_id: string;
  country: string;
  first_seen_at: string;
  last_seen_at: string;
}
interface AlertRow {
  id: string;
  user_id: string;
  session_id: string | null;
  new_device: boolean;
  new_country: boolean;
  client: string;
  device_label: string;
  device_family: string;
  device_hash: string | null;
  country: string | null;
  city: string | null;
  status: string;
  resolved_at: string | null;
  [column: string]: unknown;
}

type TableName =
  | 'user_login_devices'
  | 'organization_members'
  | 'user_sign_in_countries'
  | 'sign_in_alerts';

const db = vi.hoisted(() => ({
  devices: [] as DeviceRow[],
  members: [] as MemberRow[],
  countries: [] as CountryRow[],
  alerts: [] as AlertRow[],
  /** Forces the next insert's answer on a table (a refusal the table would not give). */
  insertError: null as null | { code: string; message: string },
  insertErrorTable: 'user_login_devices' as string,
  /** Forces the next count's answer on user_sign_in_countries. */
  countError: null as null | { code: string; message: string },
  /** Every delete on these tables is refused with this, or throws ('throw'), until cleared. */
  deleteError: {} as Record<string, { code: string; message: string } | 'throw'>,
  /** The next insert on this table throws (the network, not a refusal). */
  insertThrowsTable: null as string | null,
  nextId: 1,
  /** What was asked of each table, in order: `<op>:<table>`. */
  ops: [] as string[],
  clock: 0,
}));

type Filter = ['eq' | 'is' | 'not' | 'neq', string, unknown];

/** sign_in_alerts' checks (migration sign_in_alerts), as the database would refuse a row: 23514. */
function alertRefusal(row: AlertRow): string | null {
  const words = /^[A-Za-z0-9 ()+.-]{1,120}$/;
  if (!(row.new_device || row.new_country)) return 'sign_in_alerts_new_device_or_country';
  if (row.new_country && row.country === null) return 'sign_in_alerts_new_country_named';
  if (!['web', 'phone'].includes(row.client)) return 'sign_in_alerts_client';
  if (!words.test(row.device_label)) return 'sign_in_alerts_device_label';
  if (!words.test(row.device_family)) return 'sign_in_alerts_device_family';
  if (row.device_hash !== null && !/^[0-9a-f]{40}$/.test(row.device_hash)) return 'sign_in_alerts_device_hash';
  if (row.country !== null && !/^[A-Z]{2}$/.test(row.country)) return 'sign_in_alerts_country';
  if (row.city !== null && /[@/\\:;<>(){}[\]=?&%#"|$*+^~`]|[0-9].*[0-9].*[0-9].*[0-9]/.test(row.city)) {
    return 'sign_in_alerts_city';
  }
  if ((row.status === 'open') !== (row.resolved_at === null)) return 'sign_in_alerts_resolved_with_answer';
  for (const column of ['ip', 'last_ip', 'email', 'user_agent']) {
    if (column in row) return `no column ${column}`;
  }
  return null;
}

function tableClient(name: TableName) {
  const q = {
    op: 'select' as 'select' | 'insert' | 'update' | 'delete',
    head: false,
    payload: null as Record<string, unknown> | null,
    filters: [] as Filter[],
    limit: Infinity,
    returning: false,
  };
  const rows = (): Array<Record<string, unknown>> =>
    (name === 'user_login_devices'
      ? db.devices
      : name === 'organization_members'
        ? db.members
        : name === 'user_sign_in_countries'
          ? db.countries
          : db.alerts) as unknown as Array<Record<string, unknown>>;
  const setRows = (next: Array<Record<string, unknown>>) => {
    if (name === 'user_login_devices') db.devices = next as unknown as DeviceRow[];
    else if (name === 'organization_members') db.members = next as unknown as MemberRow[];
    else if (name === 'user_sign_in_countries') db.countries = next as unknown as CountryRow[];
    else db.alerts = next as unknown as AlertRow[];
  };
  const matches = (r: Record<string, unknown>) =>
    q.filters.every(([kind, col, value]) =>
      kind === 'eq'
        ? r[col] === value
        : kind === 'neq'
          ? r[col] !== value
          : kind === 'is'
            ? (r[col] ?? null) === value
            : (r[col] ?? null) !== value,
    );
  const run = (): { data: unknown; error: unknown; count?: number } => {
    db.ops.push(`${q.op}:${name}`);
    if (q.op === 'insert') {
      if (db.insertThrowsTable === name) {
        db.insertThrowsTable = null;
        throw new Error(`insert into ${name} threw for member@example.com`);
      }
      if (db.insertError && db.insertErrorTable === name) {
        const error = db.insertError;
        db.insertError = null;
        return { data: null, error };
      }
      if (name === 'user_login_devices') {
        const p = q.payload as unknown as DeviceRow;
        if (db.devices.some((d) => d.user_id === p.user_id && d.device_hash === p.device_hash)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        db.devices.push({ ...p, id: `device-${db.nextId++}` });
        return { data: null, error: null };
      }
      if (name === 'user_sign_in_countries') {
        const p = q.payload as unknown as CountryRow;
        if (!/^[A-Z]{2}$/.test(p.country)) {
          return { data: null, error: { code: '23514', message: 'user_sign_in_countries_country' } };
        }
        if (db.countries.some((c) => c.user_id === p.user_id && c.country === p.country)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        const at = new Date(Date.UTC(2026, 10, 20) + db.clock++ * 1000).toISOString();
        // The table's defaults fill the two times the insert leaves out.
        const sent = p as Partial<CountryRow> & Pick<CountryRow, 'user_id' | 'country'>;
        db.countries.push({ ...sent, first_seen_at: sent.first_seen_at ?? at, last_seen_at: sent.last_seen_at ?? at });
        return { data: null, error: null };
      }
      if (name === 'sign_in_alerts') {
        const id = `0000aaaa-0000-4000-8000-${String(db.nextId++).padStart(12, '0')}`;
        const row = {
          status: 'open',
          resolved_at: null,
          session_id: null,
          device_hash: null,
          country: null,
          city: null,
          ...(q.payload as Record<string, unknown>),
          id,
        } as AlertRow;
        const refused = alertRefusal(row);
        if (refused) return { data: null, error: { code: '23514', message: refused } };
        db.alerts.push(row);
        return { data: q.returning ? [{ id }] : null, error: null };
      }
      throw new Error(`insert into ${name} is not modelled`);
    }
    if (q.op === 'delete') {
      const refusal = db.deleteError[name];
      if (refusal === 'throw') throw new Error(`delete from ${name} threw for member@example.com`);
      if (refusal) return { data: null, error: refusal };
      setRows(rows().filter((r) => !matches(r)));
      return { data: null, error: null };
    }
    if (q.op === 'update') {
      for (const r of rows().filter(matches)) Object.assign(r, q.payload);
      return { data: null, error: null };
    }
    if (name === 'user_sign_in_countries' && q.head && db.countError) {
      const error = db.countError;
      db.countError = null;
      return { data: null, error };
    }
    const found = rows().filter(matches).slice(0, q.limit);
    return q.head ? { data: null, error: null, count: found.length } : { data: found, error: null };
  };
  const b = {
    select: (_cols?: string, opts?: { head?: boolean; count?: string }) => {
      if (q.op === 'insert' || q.op === 'update') q.returning = true;
      else q.head = opts?.head === true;
      return b;
    },
    insert: (payload: Record<string, unknown>) => {
      q.op = 'insert';
      q.payload = payload;
      return b;
    },
    delete: () => {
      q.op = 'delete';
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
    neq: (col: string, value: unknown) => {
      q.filters.push(['neq', col, value]);
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
    single: async () => {
      const r = run();
      const list = r.data as unknown[] | null;
      if (r.error) return { data: null, error: r.error };
      if (!list || list.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'not one row' } };
      return { data: list[0], error: null };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(resolve, reject),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: TableName) => tableClient(t),
  }),
}));
const sendNewDeviceLoginEmail = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => {
    db.ops.push('email');
  }),
);
vi.mock('@/lib/email/login-alert', () => ({ sendNewDeviceLoginEmail }));
const dispatchEvent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent }));
const reportError = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
// The "This was not me" link: its format and key are tested in
// sign-in-alert-link.test.ts; here only which alert it names.
vi.mock('@/lib/auth/sign-in-alert-url', () => ({
  signInAlertLinkUrl: vi.fn(
    ({ alertId }: { alertId: string }) =>
      `https://app.example.test/sign-in-alert?a=${alertId}&i=20261120&t=${'x'.repeat(43)}`,
  ),
}));
const recordSignInAlertEvent = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => undefined),
);
vi.mock('@/server/security/sign-in-alert-events', () => ({ recordSignInAlertEvent }));
// The bucket table, in memory, with lib/rate-limit's own answer when its
// store cannot be reached: a closed bucket refuses, an open one allows.
const limiter = vi.hoisted(() => ({
  buckets: new Map<string, number>(),
  storeDown: false,
  /** Only the buckets whose key starts with this cannot answer. */
  downPrefix: null as string | null,
  calls: [] as Array<{ key: string; limit: number; windowMs: number; mode?: string }>,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number, mode?: string) => {
    limiter.calls.push({ key, limit, windowMs, mode });
    if (limiter.storeDown || (limiter.downPrefix && key.startsWith(limiter.downPrefix))) {
      return mode === 'closed'
        ? { allowed: false, count: limit, resetAt: Date.now() + windowMs, failed: true }
        : { allowed: true, count: 0, resetAt: Date.now() + windowMs, failed: true };
    }
    const count = (limiter.buckets.get(key) ?? 0) + 1;
    if (count > limit) return { allowed: false, count: limit, resetAt: Date.now() + windowMs };
    limiter.buckets.set(key, count);
    return { allowed: true, count, resetAt: Date.now() + windowMs };
  }),
}));

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
  db.countries = [];
  db.alerts = [];
  db.insertError = null;
  db.insertErrorTable = 'user_login_devices';
  db.countError = null;
  db.deleteError = {};
  db.insertThrowsTable = null;
  db.nextId = 1;
  db.ops = [];
  db.clock = 0;
  recordSignInAlertEvent.mockClear();
  sendNewDeviceLoginEmail.mockClear();
  dispatchEvent.mockClear();
  reportError.mockClear();
  limiter.buckets.clear();
  limiter.storeDown = false;
  limiter.downPrefix = null;
  limiter.calls.length = 0;
});

describe('noteLoginDevice — new-device alerts per account and per organization', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const HOUR_MS = 60 * 60_000;
  const installs = Array.from(
    { length: 8 },
    (_, i) => `0f6c2d1e-8a4b-4c5d-9e6f-${String(i).padStart(12, '0')}`,
  );
  const memberOf = (...orgs: string[]) => {
    db.members = orgs.map((organization_id) => ({
      user_id: USER,
      organization_id,
      accepted_at: '2026-01-01T00:00:00Z',
      impersonation_expires_at: null,
    }));
  };

  it('at most 5 alert emails a day per account: every device is recorded and every alert is written; from the sixth on only the email is held', async () => {
    memberOf('org-a');
    await web();
    for (const install of installs) await phone(install);
    expect(db.devices).toHaveLength(1 + installs.length);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(5);
    // The record of each alert is still written, so Active sessions and the
    // organization's list show the sixth sign-in on (review 1, finding 6),
    // and the organization's own channels still hear of it (their own count
    // of 30 an hour paces them).
    expect(db.alerts).toHaveLength(installs.length);
    expect(dispatchEvent).toHaveBeenCalledTimes(installs.length);
    expect(limiter.calls).toContainEqual({
      key: `new-device-alert:user:${USER}`,
      limit: 5,
      windowMs: DAY_MS,
      mode: 'closed',
    });
  });

  it('the account bucket is asked only for a device that would alert', async () => {
    await phone(installs[0]!);
    // The first device ever is the silent baseline; a known device is a refresh.
    await phone(installs[0]!);
    expect(limiter.calls.filter((c) => c.key.startsWith('new-device-alert:'))).toEqual([]);
  });

  it('the account bucket held: one report for the account, never the address or the email', async () => {
    await web();
    for (const install of installs) await phone(install);
    const held = reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'auth.new_device_alerts_held',
    );
    expect(held).toHaveLength(1);
    expect(JSON.stringify(held)).not.toContain(EMAIL);
    expect(JSON.stringify(held)).not.toContain('203.0.113.7');
    expect(JSON.stringify(held)).not.toContain(USER);
  });

  it('a limiter that cannot answer: no email, no event, no held report, and the device is not left recorded', async () => {
    memberOf('org-a');
    await web();
    limiter.storeDown = true;
    await phone(installs[0]!);
    expect(db.devices).toHaveLength(1);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

    // The next sign-in from that device, with the limiter back, is new and alerts.
    limiter.storeDown = false;
    await phone(installs[0]!);
    expect(db.devices).toHaveLength(2);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('a count refusal keeps the device recorded and writes the alert; only the email is held', async () => {
    await web();
    limiter.buckets.set(`new-device-alert:user:${USER}`, 5);
    await phone(installs[0]!);
    expect(db.devices).toHaveLength(2);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, status: 'open' });
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });

  it('the email that reaches the count, and only that one, says no more will come for 24 hours', async () => {
    await web();
    for (const install of installs.slice(0, 5)) await phone(install);
    expect(sendNewDeviceLoginEmail.mock.calls.map((c) => c[0].lastForADay)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('events held for an organization: one report per organization per window, the organization id only', async () => {
    memberOf('org-a');
    limiter.buckets.set('new-device-event:org:org-a', 30);
    await web();
    await phone(installs[0]!);
    await phone(installs[1]!);
    const held = reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'auth.new_device_events_held',
    );
    expect(held).toHaveLength(1);
    expect(held[0]![1]).toMatchObject({ level: 'warning', organizationId: 'org-a' });
    expect(limiter.calls).toContainEqual({
      key: 'new-device-event-held:org:org-a',
      limit: 1,
      windowMs: HOUR_MS,
      mode: 'closed',
    });
    const text = JSON.stringify(held);
    for (const absent of [USER, EMAIL, '203.0.113.7', FAMILY]) expect(text).not.toContain(absent);
  });

  it('at most 30 new-device events an hour per organization, closed; the email and other organizations are not held by it', async () => {
    memberOf('org-a', 'org-b');
    limiter.buckets.set('new-device-event:org:org-a', 30);
    await web();
    await phone(installs[0]!);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls.map((c) => c[0])).toEqual(['org-b']);
    expect(limiter.calls).toContainEqual({
      key: 'new-device-event:org:org-a',
      limit: 30,
      windowMs: HOUR_MS,
      mode: 'closed',
    });
  });

  it('an organization bucket that cannot answer sends no event to it, and reports no held events', async () => {
    memberOf('org-a');
    await web();
    limiter.downPrefix = 'new-device-event:';
    await phone(installs[0]!);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(
      reportError.mock.calls.filter(
        (c) => (c[1] as { tag: string }).tag === 'auth.new_device_events_held',
      ),
    ).toEqual([]);
  });
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
      lastForADay: false,
      place: { country: null, city: null },
      newDevice: true,
      newCountry: false,
      notMeUrl: `https://app.example.test/sign-in-alert?a=${db.alerts[0]!.id}&i=20261120&t=${'x'.repeat(43)}`,
    });
    expect(db.devices[1]!.user_agent).toBe(LABEL);
    // Integrator decision (device label, 2026-11-02): the sign-in note keeps
    // only the device family in the organization's activity. Part 3 adds the
    // country (two letters, or null when unknown), never the city.
    expect(dispatchEvent).toHaveBeenCalledWith('org-a', 'security.new_device_login', {
      userId: USER,
      device: FAMILY,
      country: null,
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

describe('noteLoginDevice — a web sign-in is named by its browser and system, from fixed words (S56)', () => {
  const FIREFOX_WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
  /** An agent that names no browser or system this app knows, and carries text of its own. */
  const OTHER_TEXT = '<https://example.com/x|Open> Size <10> [x](https://example.com)';

  const member = () => {
    db.members = [
      {
        user_id: USER,
        organization_id: 'org-a',
        accepted_at: '2026-01-01T00:00:00Z',
        impersonation_expires_at: null,
      },
    ];
  };
  /** A second web sign-in, from another browser, on an account that has a device. */
  const secondWebSignIn = async (userAgent: string | null) => {
    member();
    await web();
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent, ip: '203.0.113.9' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    return dispatchEvent.mock.calls[0]![2] as { userId: string; device: string };
  };

  it('the event names the browser and system, not the agent', async () => {
    const data = await secondWebSignIn(FIREFOX_WINDOWS);
    expect(data).toEqual({ userId: USER, device: 'Firefox on Windows', country: null });
    // The person's own list and email still get the agent.
    expect(db.devices[1]!.user_agent).toBe(FIREFOX_WINDOWS);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: FIREFOX_WINDOWS, deviceLabel: null }),
    );
  });

  it('an agent that names neither is "Unknown browser on Unknown OS", with none of its text', async () => {
    const data = await secondWebSignIn(OTHER_TEXT);
    expect(data.device).toBe('Unknown browser on Unknown OS');
    expect(JSON.stringify(dispatchEvent.mock.calls)).not.toContain('example.com');
    expect(JSON.stringify(dispatchEvent.mock.calls)).not.toContain('<');
  });

  it('an agent that names a known browser and carries other text gives the fixed words only', async () => {
    const data = await secondWebSignIn(`${FIREFOX_WINDOWS} ${OTHER_TEXT}`);
    expect(data.device).toBe('Firefox on Windows');
  });

  it('a label without a family does not reach the event either', async () => {
    member();
    await web();
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
    });
    const data = dispatchEvent.mock.calls[0]![2] as { device: string };
    expect(data.device).toBe('Unknown browser on Unknown OS');
    expect(db.devices[1]!.user_agent).toBe(LABEL);
  });

  it('end to end: the Slack and Teams cards built from the event carry the fixed words only', async () => {
    const data = await secondWebSignIn(`${FIREFOX_WINDOWS} ${OTHER_TEXT}`);
    const { buildRequest } = await vi.importActual<
      typeof import('@/server/services/integration-events')
    >('@/server/services/integration-events');
    for (const type of ['slack', 'teams'] as const) {
      const { body } = buildRequest(
        {
          id: 'ep-1',
          organization_id: 'org-a',
          type,
          url: 'https://example.com/hook',
          secret: null,
        },
        'security.new_device_login',
        { id: 'd-1', event: 'security.new_device_login', organization_id: 'org-a', data },
      );
      const { text } = JSON.parse(body) as { text: string };
      expect(text).toContain('(Firefox on Windows)');
      expect(text).not.toContain('Mozilla');
      expect(text).not.toContain('example.com');
      expect(text).not.toMatch(/[<>[\]]/);
    }
  });
});

// ── Part 3: sign-in alerts ──────────────────────────────────────────────────

describe('noteLoginDevice — the country rule (part 3)', () => {
  const SESSION = '5e551011-0000-4000-8000-000000000001';
  const signIn = (country: string | null, overrides: Record<string, unknown> = {}) =>
    noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: WEB_UA,
      ip: '203.0.113.9',
      place: { country, city: country === 'MX' ? 'Tijuana' : null },
      sessionId: SESSION,
      client: 'web',
      ...overrides,
    });

  it('the first country an account is ever seen in is recorded silently, as the first device is', async () => {
    await signIn('US');
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(recordSignInAlertEvent).not.toHaveBeenCalled();
  });

  it('a known country is silent, and its row is kept up to date', async () => {
    await signIn('US');
    const first = db.countries[0]!.last_seen_at;
    await signIn('US');
    expect(db.countries).toHaveLength(1);
    expect(db.countries[0]!.last_seen_at).not.toBe(first);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });

  it('a new country on a known device alerts once: one row (new_country only), one email, one security event, and no new-device webhook', async () => {
    db.members = [
      { user_id: USER, organization_id: 'org-a', accepted_at: '2026-01-01T00:00:00Z', impersonation_expires_at: null },
    ];
    await signIn('US');
    await signIn('MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: false, new_country: true, country: 'MX', city: 'Tijuana' });
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(sendNewDeviceLoginEmail.mock.calls[0]![0]).toMatchObject({
      newDevice: false,
      newCountry: true,
      place: { country: 'MX', city: 'Tijuana' },
    });
    expect(recordSignInAlertEvent).toHaveBeenCalledTimes(1);
    expect(recordSignInAlertEvent).toHaveBeenCalledWith({
      reason: 'sign_in_new_country',
      userId: USER,
      source: 'web',
      place: { country: 'MX', city: 'Tijuana' },
    });
    // The webhook event is about a new device; this device is known.
    expect(dispatchEvent).not.toHaveBeenCalled();

    // The same country again: known now, silent.
    await signIn('MX');
    expect(db.alerts).toHaveLength(1);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
  });

  it('a new device in a new country is ONE alert with both flags, one email', async () => {
    await signIn('US');
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: '203.0.113.7',
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country: 'MX', city: 'Tijuana' },
      sessionId: SESSION,
      client: 'phone',
    });
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: true, client: 'phone' });
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(sendNewDeviceLoginEmail.mock.calls[0]![0]).toMatchObject({ newDevice: true, newCountry: true });
    expect(recordSignInAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'sign_in_new_country', source: 'phone' }),
    );
  });

  it('the country is a plain INSERT: nothing reads this country first, and a 23505 means "known"', async () => {
    await signIn('US');
    db.ops = [];
    await signIn('US');
    const countryOps = db.ops.filter((op) => op.endsWith(':user_sign_in_countries'));
    expect(countryOps[0]).toBe('insert:user_sign_in_countries');
    expect(countryOps).toEqual(['insert:user_sign_in_countries', 'update:user_sign_in_countries']);
  });

  it('a country refused another way is reported with its code, and the sign-in alerts by device as before', async () => {
    await signIn('US');
    db.insertError = { code: '57014', message: 'timeout for member@example.com' };
    db.insertErrorTable = 'user_sign_in_countries';
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      place: { country: 'MX', city: null },
      client: 'phone',
    });
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: false });
    const reported = reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'auth.sign_in_country_note_failed',
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]![1]).toEqual({
      tag: 'auth.sign_in_country_note_failed',
      level: 'warning',
      extra: { code: '57014' },
    });
    expect(JSON.stringify(reported)).not.toContain(EMAIL);
  });

  it('a count that cannot be read after the insert: the row is taken back, so the country is still new next time, and nothing alerts for it', async () => {
    await signIn('US');
    db.countError = { code: '57014', message: 'timeout' };
    await signIn('MX');
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    await signIn('MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_country: true, country: 'MX' });
  });

  it('with no place (off Vercel, or a header that failed its rule) no country is noted and none alerts', async () => {
    await signIn(null);
    await signIn(null);
    expect(db.countries).toEqual([]);
    expect(db.alerts).toEqual([]);
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'mx', city: null } });
    expect(db.countries).toEqual([]);
  });

  it('new-country alerts share the account’s 5-emails-a-day count with new-device alerts; every alert is still written', async () => {
    await signIn('US');
    for (const country of ['MX', 'CA', 'BR', 'DE', 'FR', 'JP', 'NL']) await signIn(country);
    expect(db.countries).toHaveLength(8);
    expect(db.alerts).toHaveLength(7);
    expect(db.alerts.map((a) => a.country)).toEqual(['MX', 'CA', 'BR', 'DE', 'FR', 'JP', 'NL']);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(5);
    expect(recordSignInAlertEvent).toHaveBeenCalledTimes(7);
    expect(limiter.calls.filter((c) => c.key === `new-device-alert:user:${USER}`)).toHaveLength(7);
  });

  it('the limiter cannot answer: BOTH rows this sign-in added are taken back, nothing is written or sent, and the next sign-in alerts with both flags', async () => {
    await signIn('US');
    limiter.storeDown = true;
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country: 'MX', city: null },
      client: 'phone',
    });
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(recordSignInAlertEvent).not.toHaveBeenCalled();

    limiter.storeDown = false;
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country: 'MX', city: null },
      client: 'phone',
    });
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: true });
  });

  it('the limiter cannot answer for a known device in a new country: only the country row is taken back', async () => {
    await signIn('US');
    limiter.storeDown = true;
    await signIn('MX');
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
  });

  it('a count refusal keeps both rows and writes the alert: only the email is held', async () => {
    await signIn('US');
    limiter.buckets.set(`new-device-alert:user:${USER}`, 5);
    await signIn('MX');
    expect(db.countries.map((c) => c.country)).toEqual(['US', 'MX']);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: false, new_country: true, country: 'MX', session_id: SESSION });
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });
});

describe('noteLoginDevice — the country step never costs the device alert (review 1, finding 5)', () => {
  const newPhoneFrom = (country: string) =>
    noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country, city: null },
      client: 'phone',
    });
  const known = () =>
    noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'US', city: null } });
  const tagged = (tag: string) =>
    reportError.mock.calls.filter((c) => (c[1] as { tag: string }).tag === tag);

  it('the count read fails and the take-back fails too: the new device still alerts, and the failed take-back is reported once', async () => {
    await known();
    db.countError = { code: '57014', message: 'timeout' };
    db.deleteError.user_sign_in_countries = { code: '42501', message: 'refused for member@example.com' };
    await newPhoneFrom('MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: false });
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    const undo = tagged('auth.sign_in_note_undo_failed');
    expect(undo).toHaveLength(1);
    expect(undo[0]![1]).toEqual({
      tag: 'auth.sign_in_note_undo_failed',
      level: 'warning',
      extra: { row: 'country', code: '42501' },
    });
    expect(tagged('auth.login_device_note_failed')).toEqual([]);
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(EMAIL);
  });

  it('the country insert throws: the new device still alerts, and it is reported with no text of the failure', async () => {
    await known();
    db.insertThrowsTable = 'user_sign_in_countries';
    await newPhoneFrom('MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: false });
    expect(tagged('auth.sign_in_country_note_failed')).toHaveLength(1);
    expect(tagged('auth.login_device_note_failed')).toEqual([]);
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(EMAIL);
  });

  it('the take-back throws: the new device still alerts', async () => {
    await known();
    db.countError = { code: '57014', message: 'timeout' };
    db.deleteError.user_sign_in_countries = 'throw';
    await newPhoneFrom('MX');
    expect(db.alerts).toHaveLength(1);
    expect(tagged('auth.sign_in_note_undo_failed')).toHaveLength(1);
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(EMAIL);
  });

  it('a count that cannot be read is reported with its code', async () => {
    await known();
    db.countError = { code: '57014', message: 'timeout for member@example.com' };
    await newPhoneFrom('MX');
    const reported = tagged('auth.sign_in_country_note_failed');
    expect(reported).toHaveLength(1);
    expect(reported[0]![1]).toEqual({
      tag: 'auth.sign_in_country_note_failed',
      level: 'warning',
      extra: { code: '57014', step: 'count' },
    });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(EMAIL);
  });
});

describe('noteLoginDevice — each take-back runs whatever the other one did (review 1, finding 5)', () => {
  const newPhoneFromMexico = () =>
    noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country: 'MX', city: null },
      client: 'phone',
    });
  const undoReports = () =>
    reportError.mock.calls
      .filter((c) => (c[1] as { tag: string }).tag === 'auth.sign_in_note_undo_failed')
      .map((c) => (c[1] as { extra: unknown }).extra);

  beforeEach(async () => {
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'US', city: null } });
    limiter.storeDown = true;
  });

  it('the device row cannot be taken back: the country row still is, and the failure is reported once', async () => {
    db.deleteError.user_login_devices = { code: '42501', message: 'refused' };
    await newPhoneFromMexico();
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.devices).toHaveLength(2);
    expect(undoReports()).toEqual([{ row: 'device', code: '42501' }]);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });

  it('the device take-back throws: the country row is still taken back', async () => {
    db.deleteError.user_login_devices = 'throw';
    await newPhoneFromMexico();
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(undoReports()).toEqual([{ row: 'device', code: null }]);
  });

  it('the country row cannot be taken back: the device row still is', async () => {
    db.deleteError.user_sign_in_countries = { code: '57014', message: 'timeout' };
    await newPhoneFromMexico();
    expect(db.devices).toHaveLength(1);
    expect(db.countries).toHaveLength(2);
    expect(undoReports()).toEqual([{ row: 'country', code: '57014' }]);
  });

  it('neither can be taken back: each is reported once, and nothing is thrown or sent', async () => {
    db.deleteError.user_login_devices = { code: '42501', message: 'refused' };
    db.deleteError.user_sign_in_countries = 'throw';
    await expect(newPhoneFromMexico()).resolves.toBeUndefined();
    expect(undoReports()).toEqual([
      { row: 'device', code: '42501' },
      { row: 'country', code: null },
    ]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(EMAIL);
  });
});

describe('noteLoginDevice — past the daily email count the alert is still recorded (review 1, finding 6)', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const SESSION = '5e551011-0000-4000-8000-000000000003';
  const ROWS_KEY = `sign-in-alert-rows:user:${USER}`;
  const newPhone = (n: number, country = 'US') =>
    noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: `0f6c2d1e-8a4b-4c5d-9e6f-${String(n).padStart(12, '0')}`,
      deviceLabel: LABEL,
      deviceFamily: FAMILY,
      place: { country, city: null },
      sessionId: SESSION,
      client: 'phone',
    });
  const known = () =>
    noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'US', city: null } });
  const tagged = (tag: string) =>
    reportError.mock.calls.filter((c) => (c[1] as { tag: string }).tag === tag);

  it('the sixth sign-in of a day from a new device: its alert row is written, with its session, and only the email is held', async () => {
    db.members = [
      { user_id: USER, organization_id: 'org-a', accepted_at: '2026-01-01T00:00:00Z', impersonation_expires_at: null },
    ];
    await known();
    for (let n = 1; n <= 6; n++) await newPhone(n);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(5);
    expect(db.alerts).toHaveLength(6);
    expect(db.alerts[5]).toMatchObject({ new_device: true, session_id: SESSION, status: 'open', device_family: FAMILY });
    // The device is learned, as before: the alert stands for it.
    expect(db.devices).toHaveLength(7);
    // Held once per window, as before.
    expect(tagged('auth.new_device_alerts_held')).toHaveLength(1);
  });

  it('a held alert from a new country is recorded with its country and its security event', async () => {
    await known();
    limiter.buckets.set(`new-device-alert:user:${USER}`, 5);
    await newPhone(1, 'MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: true, country: 'MX' });
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(recordSignInAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'sign_in_new_country', userId: USER }),
    );
  });

  it('the email is held and the row cannot be written: the sign-in would leave no trace, so nothing is learned and it is still new next time', async () => {
    db.members = [
      { user_id: USER, organization_id: 'org-a', accepted_at: '2026-01-01T00:00:00Z', impersonation_expires_at: null },
    ];
    await known();
    limiter.buckets.set(`new-device-alert:user:${USER}`, 5);
    db.insertError = { code: '57014', message: 'timeout' };
    db.insertErrorTable = 'sign_in_alerts';
    await newPhone(1, 'MX');
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(tagged('auth.sign_in_alert_insert_failed')).toHaveLength(1);

    await newPhone(1, 'MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: true });
  });

  it('a hard ceiling of 50 alert rows a day per account, counted in its own closed bucket before anything is written', async () => {
    await known();
    await newPhone(1);
    expect(limiter.calls[0]).toEqual({ key: ROWS_KEY, limit: 50, windowMs: DAY_MS, mode: 'closed' });
    expect(limiter.calls[1]).toMatchObject({ key: `new-device-alert:user:${USER}` });
  });

  it('past the ceiling nothing is learned and nothing is written: both rows are taken back, no row, no email, no event', async () => {
    db.members = [
      { user_id: USER, organization_id: 'org-a', accepted_at: '2026-01-01T00:00:00Z', impersonation_expires_at: null },
    ];
    await known();
    limiter.buckets.set(ROWS_KEY, 50);
    await newPhone(1, 'MX');
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(recordSignInAlertEvent).not.toHaveBeenCalled();
    // The email count is not spent on it.
    expect(limiter.calls.filter((c) => c.key === `new-device-alert:user:${USER}`)).toEqual([]);

    // Still new once the window has passed: it alerts then, with both flags.
    limiter.buckets.delete(ROWS_KEY);
    await newPhone(1, 'MX');
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ new_device: true, new_country: true });
  });

  it('the ceiling is reported once per window, with a hash of the account id only', async () => {
    await known();
    limiter.buckets.set(ROWS_KEY, 50);
    await newPhone(1, 'MX');
    await newPhone(2, 'CA');
    const reports = tagged('auth.sign_in_alert_rows_ceiling');
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      level: 'warning',
      extra: { limit: 50, window_hours: 24 },
    });
    expect(limiter.calls).toContainEqual({
      key: `sign-in-alert-rows-held:user:${USER}`,
      limit: 1,
      windowMs: DAY_MS,
      mode: 'closed',
    });
    const text = JSON.stringify(reports);
    for (const absent of [USER, EMAIL, LABEL, 'MX']) expect(text).not.toContain(absent);
  });

  it('the ceiling bucket cannot answer: both rows are taken back, nothing is written, and nothing is reported as a ceiling', async () => {
    await known();
    limiter.downPrefix = 'sign-in-alert-rows:';
    await newPhone(1, 'MX');
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    expect(tagged('auth.sign_in_alert_rows_ceiling')).toEqual([]);
  });

  it('the email count cannot answer: both rows are taken back and nothing is written or sent, as before', async () => {
    await known();
    limiter.downPrefix = 'new-device-alert:';
    await newPhone(1, 'MX');
    expect(db.devices).toHaveLength(1);
    expect(db.countries.map((c) => c.country)).toEqual(['US']);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });
});

describe('noteLoginDevice — the alert row (part 3)', () => {
  const SESSION = '5e551011-0000-4000-8000-000000000002';
  const FIREFOX_WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

  it('is written BEFORE the email, and the email’s link names it', async () => {
    await web();
    db.ops = [];
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: FIREFOX_WINDOWS,
      ip: '203.0.113.9',
      sessionId: SESSION,
      client: 'web',
    });
    const alertAt = db.ops.indexOf('insert:sign_in_alerts');
    expect(alertAt).toBeGreaterThan(-1);
    expect(db.ops.indexOf('email')).toBeGreaterThan(alertAt);
    expect(sendNewDeviceLoginEmail.mock.calls[0]![0].notMeUrl).toContain(`a=${db.alerts[0]!.id}`);
  });

  it('a web sign-in: both device columns are sent, in fixed words, with the session, the device row and no address, email or agent', async () => {
    await web();
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: FIREFOX_WINDOWS,
      ip: '203.0.113.9',
      sessionId: SESSION,
      client: 'web',
    });
    const expectedHash = createHash('sha256')
      .update(`${USER}::${FIREFOX_WINDOWS.replace(/[0-9]+(\.[0-9]+)*/g, '#')}`)
      .digest('hex')
      .slice(0, 40);
    expect(db.alerts[0]).toEqual({
      id: db.alerts[0]!.id,
      user_id: USER,
      session_id: SESSION,
      new_device: true,
      new_country: false,
      client: 'web',
      device_label: 'Firefox on Windows',
      device_family: 'Firefox on Windows',
      device_hash: expectedHash,
      country: null,
      city: null,
      status: 'open',
      resolved_at: null,
    });
    expect(db.devices.some((d) => d.device_hash === expectedHash)).toBe(true);
    expect(JSON.stringify(db.alerts)).not.toContain('203.0.113.9');
    expect(JSON.stringify(db.alerts)).not.toContain(EMAIL);
    expect(JSON.stringify(db.alerts)).not.toContain('Mozilla');
  });

  it('a phone sign-in: the member’s label and the organization’s family, both sent', async () => {
    await web();
    await phone(INSTALL_1);
    expect(db.alerts[0]).toMatchObject({ device_label: LABEL, device_family: FAMILY });
  });

  it('a session id that is not one is sent as none, so it cannot cost the row', async () => {
    await web();
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: FIREFOX_WINDOWS,
      ip: null,
      sessionId: 'not-a-session',
      client: 'web',
    });
    expect(db.alerts[0]!.session_id).toBeNull();
  });

  it('a city the table would refuse is emptied before the insert: the alert keeps its country', async () => {
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'US', city: null } });
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: WEB_UA,
      ip: null,
      place: { country: 'MX', city: 'Springfield (East)' },
      client: 'web',
    });
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ country: 'MX', city: null, new_country: true });
    expect(sendNewDeviceLoginEmail.mock.calls[0]![0].place).toEqual({ country: 'MX', city: null });
  });

  it('a label or family that would fail the table’s rule falls back to fixed words, so the row is never lost for it', async () => {
    await web();
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceLabel: 'StockPilot app on <b>phone</b>',
      deviceFamily: 'StockPilot/app',
      client: 'phone',
    });
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ device_label: 'Unknown device', device_family: 'Unknown device' });
  });

  it('an alert row that cannot be written is reported, and the email still goes, without the link', async () => {
    await web();
    db.insertError = { code: '57014', message: 'timeout' };
    db.insertErrorTable = 'sign_in_alerts';
    await phone(INSTALL_1);
    expect(db.alerts).toEqual([]);
    expect(sendNewDeviceLoginEmail).toHaveBeenCalledTimes(1);
    expect(sendNewDeviceLoginEmail.mock.calls[0]![0].notMeUrl).toBeNull();
    const reported = reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'auth.sign_in_alert_insert_failed',
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]![1]).toEqual({
      tag: 'auth.sign_in_alert_insert_failed',
      level: 'warning',
      extra: { code: '57014' },
    });
  });

  it('no email address: no alert at all, as before (the rows are still noted)', async () => {
    await noteLoginDevice({ userId: USER, email: null, userAgent: WEB_UA, ip: null, place: { country: 'US', city: null } });
    await noteLoginDevice({ userId: USER, email: null, userAgent: APP_UA_1, ip: null, deviceKey: INSTALL_1, place: { country: 'MX', city: null } });
    expect(db.devices).toHaveLength(2);
    expect(db.countries).toHaveLength(2);
    expect(db.alerts).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('the webhook event carries the country, two letters, and never the city', async () => {
    db.members = [
      { user_id: USER, organization_id: 'org-a', accepted_at: '2026-01-01T00:00:00Z', impersonation_expires_at: null },
    ];
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'MX', city: 'Tijuana' } });
    await noteLoginDevice({
      userId: USER,
      email: EMAIL,
      userAgent: APP_UA_1,
      ip: null,
      deviceKey: INSTALL_1,
      deviceFamily: FAMILY,
      place: { country: 'MX', city: 'Tijuana' },
      client: 'phone',
    });
    expect(dispatchEvent).toHaveBeenCalledWith('org-a', 'security.new_device_login', {
      userId: USER,
      device: FAMILY,
      country: 'MX',
    });
    expect(JSON.stringify(dispatchEvent.mock.calls)).not.toContain('Tijuana');
  });

  it('a new-device alert in a known country records no security event (only a new country does)', async () => {
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: WEB_UA, ip: null, place: { country: 'MX', city: null } });
    await noteLoginDevice({ userId: USER, email: EMAIL, userAgent: APP_UA_1, ip: null, deviceKey: INSTALL_1, place: { country: 'MX', city: null }, client: 'phone' });
    expect(db.alerts).toHaveLength(1);
    expect(recordSignInAlertEvent).not.toHaveBeenCalled();
  });

  it('never throws, whatever fails', async () => {
    await web();
    db.insertError = { code: 'XX000', message: 'boom' };
    db.insertErrorTable = 'user_login_devices';
    await expect(phone(INSTALL_1)).resolves.toBeUndefined();
  });
});
