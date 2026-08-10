import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

beforeEach(() => vi.clearAllMocks());

// MED-3: the presign path (minting a signed upload url into the po-imports
// bucket) must carry the same po_imports module + purchase_orders:manage gate
// every other import mutation carries — the web action now routes through here.
describe('PoImportsService.presignUpload — authorization gate', () => {
  it('throws forbidden when purchase_orders:manage is revoked (no storage call)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PoImportsService(
      // Effective set WITHOUT purchase_orders:manage models a revoked permission.
      makeServiceContext(stub.client, {
        role: 'manager',
        permissions: new Set<Permission>([]),
      }) as never,
    );
    const err = await svc.presignUpload({ fileName: 'po.csv', fileMimeType: 'text/csv' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
  });

  it('throws module_disabled when the po_imports module is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PoImportsService(
      makeServiceContext(stub.client, {
        role: 'admin',
        enabledModules: new Set<ModuleId>(['inventory']),
      }) as never,
    );
    const err = await svc.presignUpload({ fileName: 'po.csv', fileMimeType: 'text/csv' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('module_disabled');
  });

  it('mints a per-org signed upload url for an authorized caller', async () => {
    const createSignedUploadUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://signed.example/put' },
      error: null,
    }));
    const client = {
      storage: { from: vi.fn(() => ({ createSignedUploadUrl })) },
    };
    const svc = new PoImportsService(
      makeServiceContext(client, { role: 'admin', organizationId: 'org-9' }) as never,
    );
    const out = await svc.presignUpload({ fileName: 'invoice.PDF', fileMimeType: 'application/pdf' });
    expect(out.uploadUrl).toBe('https://signed.example/put');
    // MED-22: the path is org-scoped and its extension comes from the
    // ALLOWLISTED MIME, not from the caller's fileName.
    expect(out.storagePath).toMatch(/^org-9\/po-imports\/[0-9a-f-]+\.pdf$/);
    expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
  });
});
