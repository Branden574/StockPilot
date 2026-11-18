import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The system context every scheduled job runs as: a failed read of the
 * owner/admin or of the module set is a failure, never "no owner" and never
 * an empty module set; only reads that answered with no owner/admin are
 * "no actor".
 */

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  buildSystemContext,
  isSystemContext,
  loadSystemContext,
  systemContextLoader,
} from './system-context';

const READ_ERROR = { message: 'canceling statement due to statement timeout', code: '57014' };
const OWNER = { data: [{ user_id: 'owner-1', role: 'owner' }], error: null };
const MODULES = {
  data: [{ module_id: 'inventory' }, { module_id: 'purchase_orders' }],
  error: null,
};

const stubOf = (members: unknown, modules: unknown) =>
  makeSupabaseStub({
    'organization_members.select': members as never,
    'organization_modules.select': modules as never,
  });
const admin = (members: unknown, modules: unknown) => stubOf(members, modules).client as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSystemContext', () => {
  it('an owner and a module set read: a branded system context with the real set', async () => {
    const loaded = await loadSystemContext(admin(OWNER, MODULES), 'org-1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(isSystemContext(loaded.ctx)).toBe(true);
    expect(loaded.ctx).toMatchObject({
      organizationId: 'org-1',
      userId: 'owner-1',
      isSystem: true,
    });
    expect([...loaded.ctx.enabledModules].sort()).toEqual(['inventory', 'purchase_orders']);
  });

  it("both reads are filtered to the organization (never another tenant's owner or modules)", async () => {
    const stub = stubOf(OWNER, MODULES);
    await loadSystemContext(stub.client as never, 'org-1');
    const members = stub.chainArgsAll.get('organization_members.select') ?? [];
    const modules = stub.chainArgsAll.get('organization_modules.select') ?? [];
    expect(members).toHaveLength(1);
    expect(modules).toHaveLength(1);
    expect(members[0]).toContainEqual(['organization_id', 'org-1']);
    expect(modules[0]).toContainEqual(['organization_id', 'org-1']);
    expect(modules[0]).toContainEqual(['enabled', true]);
  });

  it('a failed members read is read_failed, never no_actor', async () => {
    expect(
      await loadSystemContext(admin({ data: null, error: READ_ERROR }, MODULES), 'org-1'),
    ).toEqual({
      ok: false,
      reason: 'read_failed',
    });
  });

  it('a failed modules read is read_failed, never a context with no modules', async () => {
    expect(
      await loadSystemContext(admin(OWNER, { data: null, error: READ_ERROR }), 'org-1'),
    ).toEqual({
      ok: false,
      reason: 'read_failed',
    });
  });

  it('reads that answered with no owner or admin are no_actor', async () => {
    expect(await loadSystemContext(admin({ data: [], error: null }, MODULES), 'org-1')).toEqual({
      ok: false,
      reason: 'no_actor',
    });
  });
});

describe('systemContextLoader', () => {
  it('reports a failed read once per run, with no organization id', async () => {
    const load = systemContextLoader(
      admin({ data: null, error: READ_ERROR }, MODULES),
      'cron.job.context',
    );
    expect(await load('org-1')).toEqual({ ok: false, reason: 'read_failed' });
    expect(await load('org-2')).toEqual({ ok: false, reason: 'read_failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect(ctx).toEqual({ tag: 'cron.job.context' });
    expect((err as Error).message).not.toMatch(/org-/);
  });

  it('reports nothing for no owner or admin', async () => {
    const load = systemContextLoader(admin({ data: [], error: null }, MODULES), 'cron.job.context');
    expect(await load('org-1')).toEqual({ ok: false, reason: 'no_actor' });
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('buildSystemContext', () => {
  it('null for no owner or admin; throws on a failed read', async () => {
    expect(await buildSystemContext(admin({ data: [], error: null }, MODULES), 'org-1')).toBeNull();
    await expect(
      buildSystemContext(admin(OWNER, { data: null, error: READ_ERROR }), 'org-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
