import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * maintenanceShareLinksEnabled(ctx): the one ctx-scoped reader of
 * organization_modules.settings.includeShareLinksInEmail (resolve(), the
 * request detail page and the phone route all ask it before a share link is
 * created or shown). A row or key that was never written means ON; a key set
 * to false means OFF; a read that returns an error means OFF and is reported,
 * because an unknown answer is not the same as "never configured".
 */

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { maintenanceShareLinksEnabled } from './maintenance-share-links';

const ENABLED_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);
const ORG_ID = 'org-example';

function build(settingsRead: QueryResult) {
  const stub = makeSupabaseStub({ 'organization_modules.select': settingsRead });
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG_ID,
    enabledModules: ENABLED_MODULES,
  });
  return { stub, ctx };
}

beforeEach(() => vi.clearAllMocks());

describe('maintenanceShareLinksEnabled', () => {
  it('a settings read that returns an error: off, and reported once without the settings', async () => {
    const { ctx } = build({ data: null, error: { message: 'connection reset', code: '08006' } });
    await expect(maintenanceShareLinksEnabled(ctx)).resolves.toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, report] = reportErrorMock.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'maintenance.share_links.setting_read',
      organizationId: ORG_ID,
    });
    expect(JSON.stringify(report)).not.toContain('includeShareLinksInEmail');
  });

  it('no settings row: on (never configured), nothing reported', async () => {
    const { ctx } = build({ data: null, error: null });
    await expect(maintenanceShareLinksEnabled(ctx)).resolves.toBe(true);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the key set to false: off, nothing reported', async () => {
    const { ctx } = build({ data: { settings: { includeShareLinksInEmail: false } }, error: null });
    await expect(maintenanceShareLinksEnabled(ctx)).resolves.toBe(false);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the key set to true: on', async () => {
    const { ctx } = build({ data: { settings: { includeShareLinksInEmail: true } }, error: null });
    await expect(maintenanceShareLinksEnabled(ctx)).resolves.toBe(true);
  });

  it('a row without the key: on (never configured)', async () => {
    const { ctx } = build({ data: { settings: { categories: ['Facilities'] } }, error: null });
    await expect(maintenanceShareLinksEnabled(ctx)).resolves.toBe(true);
  });

  it("reads this organization's maintenance module row on the caller's own client", async () => {
    const { stub, ctx } = build({ data: null, error: null });
    await maintenanceShareLinksEnabled(ctx);
    const args = stub.chainArgs.get('organization_modules.select')!;
    expect(args).toContainEqual(['organization_id', ORG_ID]);
    expect(args).toContainEqual(['module_id', 'maintenance_requests']);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});
