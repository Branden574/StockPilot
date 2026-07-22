import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { PoImportsService } from './po-imports';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

/**
 * Cancelled-PO reimport (owner request 2026-07-22).
 *
 * Root cause under test: uploads are fingerprinted by sha256 and blocked when a
 * prior import's status isn't failed/canceled/duplicate. Cancelling the
 * resulting PURCHASE ORDER never touches the import row, so the file stayed
 * permanently un-reimportable. Real case: a PO approved against the wrong
 * charter is cancelled and must be re-imported to redo it.
 *
 * The rule: a file is freed ONLY when every prior import of it produced a PO
 * that is now cancelled. Live POs (and in-flight imports) still block.
 */

const UPLOAD = {
  sourceType: 'csv' as const,
  storagePath: 'org-1/po-imports/f.csv',
  fileName: 'po.csv',
  fileMimeType: 'text/csv',
  fileSize: 10,
  sha256: 'a'.repeat(64),
};

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      organizationId: 'org-1',
      enabledModules: new Set<ModuleId>(['po_imports']),
    }),
  );
}

/** priors = po_imports rows sharing the hash; pos = their purchase_orders. */
function stubFor(
  priors: Array<Record<string, unknown>>,
  pos: Array<Record<string, unknown>> = [],
) {
  let poSelectSeen = false;
  return makeSupabaseStub({
    // First po_imports.select is the dup lookup; the insert returns the new id.
    'po_imports.select': { data: priors, error: null },
    'po_imports.insert': { data: { id: 'new-import' }, error: null },
    'purchase_orders.select': () => {
      poSelectSeen = true;
      return { data: pos, error: null };
    },
    __poSelectSeen: () => ({ data: poSelectSeen, error: null }),
  });
}

describe('PoImportsService — cancelled-PO reimport decision', () => {
  it('allows a brand-new file (no prior import)', async () => {
    const res = await svc(stubFor([])).createFromUpload(UPLOAD);
    expect(res.duplicateOf).toBeNull();
    expect(res.reimportOfCancelled).toBeNull();
    expect(res.id).toBe('new-import');
  });

  it('ALLOWS reimport when the prior import produced a CANCELLED PO (the bug)', async () => {
    const res = await svc(
      stubFor(
        [{ id: 'old-import', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' }],
        [{ id: 'po-1', status: 'cancelled', po_number: 'CVW-002200' }],
      ),
    ).createFromUpload(UPLOAD);

    expect(res.duplicateOf).toBeNull();
    expect(res.id).toBe('new-import');
    expect(res.reimportOfCancelled).toEqual({
      predecessorImportId: 'old-import',
      cancelledPoId: 'po-1',
      cancelledPoNumber: 'CVW-002200',
    });
  });

  it('still BLOCKS when the prior import produced a LIVE PO', async () => {
    for (const status of ['expected_inbound', 'ordered', 'partially_received', 'received', 'draft']) {
      const res = await svc(
        stubFor(
          [{ id: 'old-import', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' }],
          [{ id: 'po-1', status, po_number: 'CVW-1' }],
        ),
      ).createFromUpload(UPLOAD);
      expect(res.duplicateOf).toBe('old-import');
      expect(res.reimportOfCancelled).toBeNull();
    }
  });

  it('still BLOCKS an in-flight import that never produced a PO (resume, not twin)', async () => {
    const res = await svc(
      stubFor([
        { id: 'old-import', status: 'parsed', approved_po_id: null, created_at: '2026-07-01' },
      ]),
    ).createFromUpload(UPLOAD);
    expect(res.duplicateOf).toBe('old-import');
  });

  it('BLOCKS if ANY prior import of the file is still live (mixed history)', async () => {
    const res = await svc(
      stubFor(
        [
          { id: 'import-2', status: 'approved', approved_po_id: 'po-2', created_at: '2026-07-05' },
          { id: 'import-1', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' },
        ],
        [
          { id: 'po-2', status: 'ordered', po_number: 'CVW-2' },
          { id: 'po-1', status: 'cancelled', po_number: 'CVW-1' },
        ],
      ),
    ).createFromUpload(UPLOAD);
    expect(res.duplicateOf).toBe('import-2');
  });

  it('allows a SECOND reimport — several imports may share a hash (maybeSingle would throw)', async () => {
    const res = await svc(
      stubFor(
        [
          { id: 'import-2', status: 'approved', approved_po_id: 'po-2', created_at: '2026-07-05' },
          { id: 'import-1', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' },
        ],
        [
          { id: 'po-2', status: 'cancelled', po_number: 'CVW-2' },
          { id: 'po-1', status: 'cancelled', po_number: 'CVW-1' },
        ],
      ),
    ).createFromUpload(UPLOAD);
    // Newest cancelled predecessor wins for lineage.
    expect(res.duplicateOf).toBeNull();
    expect(res.reimportOfCancelled?.predecessorImportId).toBe('import-2');
  });

  it('FAILS CLOSED when the prior import points at a PO row it cannot read', async () => {
    const res = await svc(
      stubFor(
        [{ id: 'old-import', status: 'approved', approved_po_id: 'po-x', created_at: '2026-07-01' }],
        [], // PO not returned (missing / other org)
      ),
    ).createFromUpload(UPLOAD);
    expect(res.duplicateOf).toBe('old-import');
    expect(res.reimportOfCancelled).toBeNull();
  });
});
