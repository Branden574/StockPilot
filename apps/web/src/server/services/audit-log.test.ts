import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// AuditLogService gates on the EFFECTIVE activity_logs:read (can(), not the
// static hasPermission) — the whole point of the grantable audit console is
// that a viewer granted the permission via the matrix can read. These tests
// pin that, plus the eventPrefix filter driving the category chips.

const ctxHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ctxHolder.current),
  };
});

import { AuditLogService } from './audit-log';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuditLogService.list permission gate', () => {
  it('allows a viewer whose EFFECTIVE set grants activity_logs:read', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, {
      role: 'viewer',
      permissions: new Set(['activity_logs:read']),
    });
    const svc = await AuditLogService.forCurrentUser();
    await expect(svc.list()).resolves.toEqual({ rows: [], total: 0 });
  });

  it('stays forbidden for a DEFAULT viewer (no grant)', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, { role: 'viewer' });
    const svc = await AuditLogService.forCurrentUser();
    await expect(svc.list()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a manager whose effective set REVOKED the perm is denied (can(), not static role)', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, {
      role: 'manager',
      permissions: new Set(['items:read']),
    });
    const svc = await AuditLogService.forCurrentUser();
    await expect(svc.list()).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('AuditLogService.list eventPrefix filter (category chips)', () => {
  it('applies like(event, prefix%) when eventPrefix is set', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, { role: 'admin' });
    const svc = await AuditLogService.forCurrentUser();
    await svc.list({ eventPrefix: 'stock.' });
    const chain = stub.chains.get('audit_logs.select') ?? [];
    const args = stub.chainArgs.get('audit_logs.select') ?? [];
    const likeIdx = chain.indexOf('like');
    expect(likeIdx).toBeGreaterThan(-1);
    expect(args[likeIdx]).toEqual(['event', 'stock.%']);
  });

  it('an exact event filter wins over eventPrefix', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, { role: 'admin' });
    const svc = await AuditLogService.forCurrentUser();
    await svc.list({ event: 'stock.adjusted', eventPrefix: 'stock.' });
    const chain = stub.chains.get('audit_logs.select') ?? [];
    expect(chain).not.toContain('like');
    const args = stub.chainArgs.get('audit_logs.select') ?? [];
    const eqIdx = chain.indexOf('eq');
    // First eq is organization_id; find the event eq.
    const eventEq = args.filter((a, i) => chain[i] === 'eq' && a[0] === 'event');
    expect(eqIdx).toBeGreaterThan(-1);
    expect(eventEq).toEqual([['event', 'stock.adjusted']]);
  });
});

describe('AuditLogService.list date bounds (SP-042)', () => {
  // The /dashboard/audit filter bar uses <input type="date">, so `since`/
  // `until` arrive as 'YYYY-MM-DD'. Postgres casts a bare date to midnight
  // UTC, so the original `.lte('created_at', until)` matched ONLY rows
  // stamped exactly at 00:00:00Z — picking Since=Until=one day showed "no
  // entries" while that day was full of events. These pin the normalisation.
  async function runList(filters: Record<string, unknown>) {
    const stub = makeSupabaseStub({
      'audit_logs.select': { data: [], error: null, count: 0 },
    });
    ctxHolder.current = makeServiceContext(stub.client, { role: 'admin' });
    const svc = await AuditLogService.forCurrentUser();
    await svc.list(filters);
    const chain = stub.chains.get('audit_logs.select') ?? [];
    const args = stub.chainArgs.get('audit_logs.select') ?? [];
    return { chain, args, at: (m: string) => args.filter((_arg, i) => chain[i] === m) };
  }

  it('a date-only `until` becomes an EXCLUSIVE next-midnight lt bound', async () => {
    const { chain, at } = await runList({ until: '2026-09-10' });
    expect(at('lt')).toEqual([['created_at', '2026-09-11T00:00:00.000Z']]);
    expect(chain).not.toContain('lte');
  });

  it('a date-only `since` becomes an inclusive UTC-midnight gte bound', async () => {
    const { at } = await runList({ since: '2026-09-10' });
    expect(at('gte')).toEqual([['created_at', '2026-09-10T00:00:00.000Z']]);
  });

  it('a single-day range keeps both bounds so the whole day is covered', async () => {
    const { at } = await runList({ since: '2026-09-10', until: '2026-09-10' });
    expect(at('gte')).toEqual([['created_at', '2026-09-10T00:00:00.000Z']]);
    expect(at('lt')).toEqual([['created_at', '2026-09-11T00:00:00.000Z']]);
  });

  it('a full ISO `until` passes through unchanged on lte', async () => {
    const { at } = await runList({ until: '2026-09-10T15:30:00.000Z' });
    expect(at('lte')).toEqual([['created_at', '2026-09-10T15:30:00.000Z']]);
    expect(at('lt')).toEqual([]);
  });

  it('a mangled date param is ignored rather than 500ing the page', async () => {
    const { chain } = await runList({ since: '2026-13-45', until: 'not-a-date' });
    expect(chain).not.toContain('gte');
    expect(chain).not.toContain('lt');
    expect(chain).not.toContain('lte');
  });
});

// 0393: an actor who deleted their account leaves user_id null and the row's
// deleted_users marker records user_id; the page says "Deleted user".
describe('AuditLogService.list deleted actors (0393)', () => {
  it('selects the marker and flags only a null user_id stamped in deleted_users', async () => {
    const stub = makeSupabaseStub({
      'audit_logs.select': {
        data: [
          { id: 'a1', event: 'stock.adjusted', metadata: {}, ip: null, created_at: '2026-11-04T00:00:00Z', user_id: null, deleted_users: { user_id: '2026-11-04T00:00:00+00:00' }, actor: null },
          { id: 'a2', event: 'stock.adjusted', metadata: {}, ip: null, created_at: '2026-11-04T00:00:00Z', user_id: null, deleted_users: null, actor: null },
          { id: 'a3', event: 'stock.adjusted', metadata: {}, ip: null, created_at: '2026-11-04T00:00:00Z', user_id: 'u1', deleted_users: null, actor: { id: 'u1', full_name: 'Doua', email: null, avatar_url: null } },
        ],
        error: null,
        count: 3,
      },
    });
    ctxHolder.current = makeServiceContext(stub.client, { role: 'manager' });
    const svc = await AuditLogService.forCurrentUser();
    const { rows } = await svc.list();
    expect(rows.map((r) => r.actorDeleted)).toEqual([true, false, false]);
    expect(String(stub.chainArgs.get('audit_logs.select')?.[0]?.[0] ?? '')).toContain('deleted_users');
  });
});
