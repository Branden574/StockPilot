import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * A purchase order's attachments are listed with a signed link each, from ONE
 * createSignedUrls call (the rows are one order's attachments, read in one
 * request that PostgREST caps at 1,000, the most one call takes). A failed
 * call was ignored: every attachment came back without a link and nothing was
 * reported (B20a). It is reported now; the rows still come back as before,
 * each with a null link.
 */

const { reportError } = vi.hoisted(() => ({
  reportError: vi.fn(async (_err: unknown, _context: unknown) => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { PoAttachmentsService } from './po-attachments';

const ORG = 'org-test';
const PO = 'aaaaaaaa-0000-4000-8000-000000000001';

function attachment(i: number) {
  return {
    id: `att-${i}`,
    organization_id: ORG,
    purchase_order_id: PO,
    storage_path: `${ORG}/${PO}/packing-slip-${i}.pdf`,
    file_name: `packing-slip-${i}.pdf`,
    content_type: 'application/pdf',
    size_bytes: 1024,
    uploaded_by: null,
    created_at: `2026-10-0${i}T10:00:00+00:00`,
  };
}

function arrange(answer: { data: unknown; error: unknown }) {
  const rows = [attachment(2), attachment(1)];
  const stub = makeSupabaseStub({ 'po_attachments.select': { data: rows, error: null } });
  const createSignedUrls = vi.fn(async (_paths: string[], _ttl: number) => answer);
  stub.client.storage.from = vi.fn(() => ({ createSignedUrls }));
  const svc = new PoAttachmentsService(makeServiceContext(stub.client, { organizationId: ORG }));
  return { svc, rows, createSignedUrls };
}

beforeEach(() => vi.clearAllMocks());

describe('PoAttachmentsService.list: signing the links', () => {
  it('signs every row in one call and reports nothing when it works', async () => {
    const { svc, rows, createSignedUrls } = arrange({
      data: [attachment(2), attachment(1)].map((r) => ({
        path: r.storage_path,
        signedUrl: `https://signed.example/${r.storage_path}`,
        error: null,
      })),
      error: null,
    });
    const listed = await svc.list(PO);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls.mock.calls[0]![0]).toEqual(rows.map((r) => r.storage_path));
    expect(listed.map((a) => a.url)).toEqual(
      rows.map((r) => `https://signed.example/${r.storage_path}`),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  // Mutation caught: the call's error ignored again.
  it('a failed signing call is reported once, and the rows still come back, each without a link', async () => {
    const failure = Object.assign(new Error('fetch failed'), { name: 'StorageUnknownError' });
    const { svc, rows } = arrange({ data: null, error: failure });
    const listed = await svc.list(PO);
    expect(listed.map((a) => [a.id, a.fileName, a.url])).toEqual(
      rows.map((r) => [r.id, r.file_name, null]),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0]!;
    expect(err).toBe(failure);
    expect(context).toMatchObject({
      tag: 'purchase-orders.attachments.sign',
      organizationId: ORG,
      extra: { purchaseOrderId: PO, paths: 2 },
    });
  });

  it('an order with no attachments makes no call', async () => {
    const stub = makeSupabaseStub({ 'po_attachments.select': { data: [], error: null } });
    const createSignedUrls = vi.fn();
    stub.client.storage.from = vi.fn(() => ({ createSignedUrls }));
    const svc = new PoAttachmentsService(makeServiceContext(stub.client, { organizationId: ORG }));
    expect(await svc.list(PO)).toEqual([]);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
