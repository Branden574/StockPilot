/**
 * Tests for PoImportsService.list() / .count() — the filter/search/pagination
 * wiring that powers the imports index page's Active/Approved/Cancelled tabs,
 * ?q= search, and numbered pagination (owner request 2026-07-16: separate
 * cancelled/approved imports from the working set, with search).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// list()/count() only touch the DB. Stub the heavy collaborators the module
// pulls in so the suite stays hermetic (same preamble as po-imports.cleanup.test.ts).
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

beforeEach(() => {
  vi.clearAllMocks();
});

const ROW = {
  id: 'imp-1',
  organization_id: 'org-test',
  uploaded_by: 'user-1',
  source_type: 'pdf',
  vendor_id: null,
  warehouse_id: null,
  file_name: 'acme-po.pdf',
  file_mime_type: 'application/pdf',
  file_size: 100,
  storage_path: 'org-test/x',
  sha256: 'abc',
  status: 'parsed',
  parse_error: null,
  approved_po_id: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  extraction_confidence: null,
  extraction_model: null,
};

describe('PoImportsService.list', () => {
  it('filters by the given tab statuses via .in()', async () => {
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [ROW], error: null } });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const rows = await svc.list({ statuses: ['uploaded', 'parsing'] as never });

    expect(rows).toEqual([ROW]);
    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const inIdx = chain.indexOf('in');
    expect(inIdx).toBeGreaterThan(-1);
    expect(args[inIdx]).toEqual(['status', ['uploaded', 'parsing']]);
  });

  it('omits the .in() status filter when statuses is null/empty', async () => {
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [], error: null } });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ statuses: null });

    const chain = stub.chains.get('po_imports.select') ?? [];
    expect(chain).not.toContain('in');
  });

  it('searches the file name via escaped ILIKE (pattern #16 — %/_/\\ are literal)', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
      'purchase_orders.select': { data: [], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ q: '100%_off' });

    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const orIdx = chain.indexOf('or');
    expect(orIdx).toBeGreaterThan(-1);
    expect(args[orIdx]![0]).toBe('file_name.ilike.%100\\%\\_off%');
  });

  it('adds a supplier-name match (vendor_id IN (...)) when the search resolves suppliers — org-scoped lookup', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: [], error: null },
      'suppliers.select': { data: [{ id: 'sup-1' }, { id: 'sup-2' }], error: null },
      'purchase_orders.select': { data: [], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ q: 'acme' });

    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const orIdx = chain.indexOf('or');
    expect(args[orIdx]![0]).toBe('file_name.ilike.%acme%,vendor_id.in.(sup-1,sup-2)');

    const supplierArgs = (stub.chainArgs.get('suppliers.select') ?? []).flat();
    expect(supplierArgs).toContain('organization_id');
    expect(supplierArgs).toContain('org-test');
  });

  it('adds an approved-PO-number match (approved_po_id IN (...)) when the search resolves purchase orders', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
      'purchase_orders.select': { data: [{ id: 'po-9' }], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ q: 'PO-1002' });

    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const orIdx = chain.indexOf('or');
    expect(args[orIdx]![0]).toBe('file_name.ilike.%PO-1002%,approved_po_id.in.(po-9)');
  });

  it('combines supplier AND PO-number matches with the file-name match in one .or()', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: [], error: null },
      'suppliers.select': { data: [{ id: 'sup-1' }], error: null },
      'purchase_orders.select': { data: [{ id: 'po-9' }], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ q: 'acme' });

    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const orIdx = chain.indexOf('or');
    expect(args[orIdx]![0]).toBe(
      'file_name.ilike.%acme%,vendor_id.in.(sup-1),approved_po_id.in.(po-9)',
    );
  });

  it('never queries suppliers/purchase_orders when q is empty (no wasted round trips)', async () => {
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [], error: null } });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({});

    expect(stub.fromCalls).not.toContain('suppliers');
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('applies limit/offset via .range()', async () => {
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [], error: null } });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({ limit: 30, offset: 60 });

    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const rangeIdx = chain.indexOf('range');
    expect(rangeIdx).toBeGreaterThan(-1);
    expect(args[rangeIdx]).toEqual([60, 89]);
  });

  it('skips .range() when no limit is given (unpaginated caller)', async () => {
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [], error: null } });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.list({});

    const chain = stub.chains.get('po_imports.select') ?? [];
    expect(chain).not.toContain('range');
  });

  it('errors surface as ServiceError', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: { message: 'boom' } },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const thrown = await svc.list().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('internal_error');
  });

  it('module gate: po_imports disabled → ServiceError before any query', async () => {
    const stub = makeSupabaseStub();
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { enabledModules: new Set() as never }) as never,
    );

    const thrown = await svc.list().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect(stub.fromCalls).toHaveLength(0);
  });
});

describe('PoImportsService.count', () => {
  it('returns the exact head-only count with the same status/q filters as list()', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: null, count: 7 },
      'suppliers.select': { data: [], error: null },
      'purchase_orders.select': { data: [], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const total = await svc.count({ statuses: ['approved'] as never, q: 'acme' });

    expect(total).toBe(7);
    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const inIdx = chain.indexOf('in');
    expect(args[inIdx]).toEqual(['status', ['approved']]);
    const orIdx = chain.indexOf('or');
    expect(args[orIdx]![0]).toBe('file_name.ilike.%acme%');
    // head-only — no rows requested.
    const selectIdx = chain.indexOf('select');
    expect(args[selectIdx]).toEqual(['id', { count: 'exact', head: true }]);
  });

  it('returns 0 when the count comes back null', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: null, count: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    expect(await svc.count()).toBe(0);
  });

  it('errors surface as ServiceError', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: { message: 'count boom' } },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const thrown = await svc.count().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('internal_error');
  });

  it('module gate: po_imports disabled → ServiceError before any query', async () => {
    const stub = makeSupabaseStub();
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { enabledModules: new Set() as never }) as never,
    );

    const thrown = await svc.count().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect(stub.fromCalls).toHaveLength(0);
  });
});
