import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * po_imports.display_name (mig 0333) — the human name for an import.
 *
 * The whole feature is one nullable label, so most of what follows asserts what
 * it must NOT touch. `file_name` keeps meaning "the real uploaded filename";
 * sha256 keeps being the ONLY duplicate identity; storage_path, source_type,
 * file_mime_type, file_size and the 0286/0287 lineage columns are written
 * exactly as before. Naming an import is a relabel, never a re-import.
 */

const { mockAudit, mockParsePoFile, mockExtract, mockAdmin } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockParsePoFile: vi.fn(),
  mockExtract: vi.fn(),
  mockAdmin: vi.fn(),
}));

vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: mockParsePoFile }));
vi.mock('@/lib/po-scan/extract', () => ({
  extractPoFromMedia: mockExtract,
  SCAN_MODEL_NAME: 'claude-sonnet-5',
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdmin }));

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

/** One character, by codepoint — see the core schema test for why not raw. */
const ch = (codePoint: number) => String.fromCodePoint(codePoint);

/** A complete, valid upload payload. Tests vary ONLY `displayName`. */
const UPLOAD = {
  sourceType: 'csv' as const,
  storagePath: 'org-1/po-imports/e6f30a75-0000-4000-8000-000000000001.csv',
  fileName: 'image.jpg',
  fileMimeType: 'text/csv',
  fileSize: 4096,
  sha256: 'a'.repeat(64),
};

/**
 * A REAL (if tiny) JPEG: SOI, one SOF0 carrying dimensions, EOI.
 *
 * These fixtures used to be `new Uint8Array([1, 2, 3])` with `mimeType:
 * 'image/jpeg'` alongside — which was fine while `createFromScan` believed the
 * declared type, and is exactly the input it now refuses. Three arbitrary
 * bytes are not a JPEG, and the whole point of the change is that saying so
 * does not make it one.
 */
const REAL_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00, 0xff, 0xd9]);

const SCAN_FILES = [{ bytes: REAL_JPEG, mimeType: 'image/jpeg', fileName: 'image.jpg' }];

/** sha256 of the bytes above — a fixed literal, not a recomputation. */
const SHA_OF_FIXTURE = '1ad39ead91e6ce49ad08aedf6454190ab291a705d21620d1fa0c26732cfd02df';

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  return new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      organizationId: 'org-1',
      enabledModules: new Set<ModuleId>(['po_imports']),
      ...overrides,
    }),
  );
}

/** priors = po_imports rows sharing the hash; pos = their purchase_orders. */
function stubFor(
  priors: Array<Record<string, unknown>> = [],
  pos: Array<Record<string, unknown>> = [],
) {
  return makeSupabaseStub({
    'po_imports.select': { data: priors, error: null },
    'po_imports.insert': { data: { id: 'new-import' }, error: null },
    'po_imports.update': { data: priors.map((p) => ({ id: p.id })), error: null },
    'purchase_orders.select': { data: pos, error: null },
    'vendor_item_mappings.select': { data: [], error: null },
    'po_import_lines.insert': { data: null, error: null },
  });
}

/** The row object handed to po_imports.insert. */
function insertedRow(stub: ReturnType<typeof makeSupabaseStub>): Record<string, unknown> {
  return (stub.chainArgs.get('po_imports.insert')?.[0]?.[0] ?? {}) as Record<string, unknown>;
}

function extractedPo() {
  return {
    poNumber: 'PO-77',
    vendorName: 'Team Outfitters',
    vendorAddress: '',
    orderDate: '',
    expectedDate: '',
    subtotal: 0,
    tax: 0,
    freight: 0,
    grandTotal: 0,
    overallConfidence: 0.95,
    lines: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtract.mockResolvedValue(extractedPo());
  mockAdmin.mockReturnValue({
    storage: {
      from: () => ({
        upload: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }),
    },
  });
});

// ── createFromUpload ────────────────────────────────────────────────────────

describe('createFromUpload — display_name is persisted independently of file_name', () => {
  it('writes the name to display_name and leaves every identity/document column alone', async () => {
    const stub = stubFor();
    await svc(stub).createFromUpload({ ...UPLOAD, displayName: 'August DC4 Book Order' });

    const row = insertedRow(stub);
    expect(row.display_name).toBe('August DC4 Book Order');
    // Literal pins — the values spelled out, not read back off the subject.
    expect(row.file_name).toBe('image.jpg');
    expect(row.sha256).toBe('a'.repeat(64));
    expect(row.storage_path).toBe('org-1/po-imports/e6f30a75-0000-4000-8000-000000000001.csv');
    expect(row.source_type).toBe('csv');
    expect(row.file_mime_type).toBe('text/csv');
    expect(row.file_size).toBe(4096);
    expect(row.reimported_from_id).toBeNull();
  });

  it('OLD CLIENT: no displayName at all still succeeds, storing null', async () => {
    const stub = stubFor();
    const res = await svc(stub).createFromUpload(UPLOAD);

    expect(res.id).toBe('new-import');
    expect(res.duplicateOf).toBeNull();
    expect(insertedRow(stub).display_name).toBeNull();
    expect(insertedRow(stub).file_name).toBe('image.jpg');
  });

  it('blank and whitespace-only names normalize to null, not to an empty string', async () => {
    for (const raw of ['', '   ', `${ch(0x0a)}${ch(0x09)} `]) {
      const stub = stubFor();
      await svc(stub).createFromUpload({ ...UPLOAD, displayName: raw });
      expect(insertedRow(stub).display_name).toBeNull();
    }
  });

  it('trims a name before storing it', async () => {
    const stub = stubFor();
    await svc(stub).createFromUpload({ ...UPLOAD, displayName: '  August DC4 Book Order  ' });
    expect(insertedRow(stub).display_name).toBe('August DC4 Book Order');
  });

  it("PRESERVES ordinary punctuation — & ' ( ) # - _ survive intact", async () => {
    const stub = stubFor();
    const name = "Follett & Sons - Andrew's re-order (DC4) #12_final";
    await svc(stub).createFromUpload({ ...UPLOAD, displayName: name });
    expect(insertedRow(stub).display_name).toBe(
      "Follett & Sons - Andrew's re-order (DC4) #12_final",
    );
  });

  it('REFUSES a 161-character name and never reaches the insert', async () => {
    const stub = stubFor();
    await expect(
      svc(stub).createFromUpload({ ...UPLOAD, displayName: 'x'.repeat(161) }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chainArgs.get('po_imports.insert')).toBeUndefined();
  });

  it('ACCEPTS exactly 160 characters (the column CHECK ceiling)', async () => {
    const stub = stubFor();
    await svc(stub).createFromUpload({ ...UPLOAD, displayName: 'y'.repeat(160) });
    expect(insertedRow(stub).display_name).toBe('y'.repeat(160));
  });

  it('REFUSES control characters and Unicode bidi overrides', async () => {
    // NUL, ESC, RIGHT-TO-LEFT OVERRIDE, LEFT-TO-RIGHT ISOLATE.
    for (const cp of [0x00, 0x1b, 0x202e, 0x2066]) {
      const stub = stubFor();
      await expect(
        svc(stub).createFromUpload({ ...UPLOAD, displayName: `August${ch(cp)}DC4` }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect(stub.chainArgs.get('po_imports.insert')).toBeUndefined();
    }
  });
});

describe('createFromUpload — the name is NOT part of duplicate identity', () => {
  it('a live prior import of the same sha256 still blocks, however differently it is named', async () => {
    const stub = stubFor([
      { id: 'old-import', status: 'parsed', approved_po_id: null, created_at: '2026-08-01' },
    ]);
    const res = await svc(stub).createFromUpload({
      ...UPLOAD,
      displayName: 'A COMPLETELY DIFFERENT NAME',
    });

    expect(res.duplicateOf).toBe('old-import');
    expect(res.id).toBe('old-import');
    // Nothing was inserted — a new name did not buy a new import.
    expect(stub.chainArgs.get('po_imports.insert')).toBeUndefined();
  });

  it('LINEAGE INTACT: a named re-import after a cancelled PO still stamps reimported_from_id', async () => {
    const stub = stubFor(
      [{ id: 'old-import', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' }],
      [{ id: 'po-1', status: 'cancelled', po_number: 'CVW-002200' }],
    );
    const res = await svc(stub).createFromUpload({ ...UPLOAD, displayName: 'Redo of DC4' });

    expect(res.reimportOfCancelled).toEqual({
      predecessorImportId: 'old-import',
      cancelledPoId: 'po-1',
      cancelledPoNumber: 'CVW-002200',
    });
    const row = insertedRow(stub);
    expect(row.reimported_from_id).toBe('old-import');
    expect(row.display_name).toBe('Redo of DC4');
    expect(row.sha256).toBe('a'.repeat(64));
  });
});

// ── createFromScan ──────────────────────────────────────────────────────────

describe('createFromScan — display_name is persisted independently of file_name', () => {
  it('stores the typed name while file_name keeps the camera filename', async () => {
    const stub = stubFor();
    await svc(stub).createFromScan({
      files: SCAN_FILES,
      displayName: 'August DC4 Book Order',
    });

    const row = insertedRow(stub);
    expect(row.display_name).toBe('August DC4 Book Order');
    expect(row.file_name).toBe('image.jpg');
    expect(row.source_type).toBe('scan');
    expect(row.file_mime_type).toBe('image/jpeg');
    expect(row.file_size).toBe(REAL_JPEG.byteLength);
  });

  it('OLD CLIENT: a scan with no displayName still succeeds, storing null', async () => {
    const stub = stubFor();
    const res = await svc(stub).createFromScan({ files: SCAN_FILES });
    expect(res.id).toBe('new-import');
    expect(insertedRow(stub).display_name).toBeNull();
    expect(insertedRow(stub).file_name).toBe('image.jpg');
  });

  it('sha256 and storage_path come from the BYTES alone — the name changes neither', async () => {
    const a = stubFor();
    await svc(a).createFromScan({ files: SCAN_FILES, displayName: 'Name one' });
    const b = stubFor();
    await svc(b).createFromScan({ files: SCAN_FILES, displayName: 'A totally different name' });

    expect(insertedRow(a).sha256).toBe(SHA_OF_FIXTURE);
    expect(insertedRow(b).sha256).toBe(SHA_OF_FIXTURE);
    expect(insertedRow(a).storage_path).toBe(
      `org-1/po-imports/${SHA_OF_FIXTURE}.jpg`,
    );
    expect(insertedRow(b).storage_path).toBe(
      `org-1/po-imports/${SHA_OF_FIXTURE}.jpg`,
    );
    expect(insertedRow(a).display_name).toBe('Name one');
    expect(insertedRow(b).display_name).toBe('A totally different name');
  });

  it('REFUSES an oversized name before spending a vision call', async () => {
    const stub = stubFor();
    await expect(
      svc(stub).createFromScan({ files: SCAN_FILES, displayName: 'x'.repeat(161) }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

// ── rename ──────────────────────────────────────────────────────────────────

/** Stub for rename(): the pre-read row, then the UPDATE's returned row. */
function renameStub(
  current: Record<string, unknown> | null,
  updated: Record<string, unknown> | null = { id: 'imp-1' },
) {
  return makeSupabaseStub({
    'po_imports.select': { data: current, error: null },
    'po_imports.update': { data: updated, error: null },
  });
}

function updatePayload(stub: ReturnType<typeof makeSupabaseStub>): Record<string, unknown> {
  return (stub.chainArgs.get('po_imports.update')?.[0]?.[0] ?? {}) as Record<string, unknown>;
}

describe('PoImportsService.rename', () => {
  it('sets display_name and writes NOTHING else — no approved_po_id, no status, no file_name', async () => {
    const stub = renameStub({ id: 'imp-1', display_name: null, file_name: 'image.jpg' });
    const res = await svc(stub).rename('imp-1', '  August DC4 Book Order ');

    expect(res).toEqual({ id: 'imp-1', displayName: 'August DC4 Book Order' });
    // The ENTIRE update payload, pinned. A future edit that smuggles another
    // column in here fails this test rather than shipping.
    expect(updatePayload(stub)).toEqual({ display_name: 'August DC4 Book Order' });
    // purchase_orders is never even opened, so no po_number can be reached.
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('scopes both the read and the write to the context organization', async () => {
    const stub = renameStub({ id: 'imp-1', display_name: 'old', file_name: 'f.csv' });
    await svc(stub).rename('imp-1', 'new name');

    const eqPairs = (key: string) =>
      (stub.chainArgs.get(key) ?? []).filter((a) => a.length === 2).map((a) => [a[0], a[1]]);
    expect(eqPairs('po_imports.select')).toContainEqual(['organization_id', 'org-1']);
    expect(eqPairs('po_imports.select')).toContainEqual(['id', 'imp-1']);
    expect(eqPairs('po_imports.update')).toContainEqual(['organization_id', 'org-1']);
    expect(eqPairs('po_imports.update')).toContainEqual(['id', 'imp-1']);
  });

  it('CROSS-ORG / MISSING: a row the org cannot see is not_found — nothing updated, nothing audited', async () => {
    const stub = renameStub(null);
    await expect(svc(stub).rename('imp-other-org', 'mine now')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.chainArgs.get('po_imports.update')).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('PATTERN #2: a zero-row UPDATE is not silent success — it is not_found', async () => {
    // Readable a moment ago, then gone (deleted, or moved out from under the
    // filter). PostgREST returns no row; without the guard this returned ok
    // and audited a rename that never happened.
    const stub = renameStub({ id: 'imp-1', display_name: null, file_name: 'f.csv' }, null);
    await expect(svc(stub).rename('imp-1', 'August DC4')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('audits po_import.renamed with a real before -> after pair', async () => {
    const stub = renameStub({
      id: 'imp-1',
      display_name: 'July order',
      file_name: 'image.jpg',
    });
    await svc(stub).rename('imp-1', 'August DC4 Book Order');

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const entry = (mockAudit.mock.calls[0] as unknown as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(entry.event).toBe('po_import.renamed');
    expect(entry.entityType).toBe('po_import');
    expect(entry.entityId).toBe('imp-1');
    expect(entry.before).toEqual({ displayName: 'July order' });
    expect(entry.after).toEqual({ displayName: 'August DC4 Book Order' });
    expect(entry.extra).toEqual({ fileName: 'image.jpg' });
  });

  it('is a no-op when the name is unchanged: no UPDATE, no audit row', async () => {
    const stub = renameStub({
      id: 'imp-1',
      display_name: 'August DC4 Book Order',
      file_name: 'image.jpg',
    });
    const res = await svc(stub).rename('imp-1', 'August DC4 Book Order');
    expect(res.displayName).toBe('August DC4 Book Order');
    expect(stub.chainArgs.get('po_imports.update')).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('REFUSES a caller without purchase_orders:manage', async () => {
    const stub = renameStub({ id: 'imp-1', display_name: null, file_name: 'f.csv' });
    await expect(
      svc(stub, { role: 'viewer' }).rename('imp-1', 'August DC4'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('REFUSES when the po_imports module is not enabled for the org', async () => {
    const stub = renameStub({ id: 'imp-1', display_name: null, file_name: 'f.csv' });
    await expect(
      svc(stub, { enabledModules: new Set<ModuleId>([]) }).rename('imp-1', 'August DC4'),
    ).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('REFUSES an empty, oversized or control-character name before touching the row', async () => {
    for (const bad of ['   ', 'x'.repeat(161), `August${ch(0x202e)}DC4`]) {
      const stub = renameStub({ id: 'imp-1', display_name: null, file_name: 'f.csv' });
      await expect(svc(stub).rename('imp-1', bad)).rejects.toMatchObject({
        code: 'validation_error',
      });
      expect(stub.fromCalls).toHaveLength(0);
    }
  });
});

// ── list() / search ─────────────────────────────────────────────────────────

function orFilterFor(stub: ReturnType<typeof makeSupabaseStub>): string | undefined {
  const chain = stub.chainsAll.get('po_imports.select')?.[0] ?? [];
  const args = stub.chainArgsAll.get('po_imports.select')?.[0] ?? [];
  const idx = chain.indexOf('or');
  return idx === -1 ? undefined : (args[idx]?.[0] as string | undefined);
}

describe('list() — display_name is searchable ALONGSIDE file_name', () => {
  it('selects display_name so the list can render it', async () => {
    const stub = stubFor();
    await svc(stub).list();
    const columns = stub.chainArgs.get('po_imports.select')?.[0]?.[0] as string;
    expect(columns).toContain('display_name');
    expect(columns).toContain('file_name');
  });

  it('matches BOTH the human name and the file name for one search term', async () => {
    const stub = stubFor();
    await svc(stub).list({ q: 'august' });
    const or = orFilterFor(stub);
    expect(or).toContain('display_name.ilike.%august%');
    expect(or).toContain('file_name.ilike.%august%');
  });

  it('keeps the existing escaping EXACTLY: ILIKE wildcards escaped, .or() metacharacters stripped', async () => {
    const stub = stubFor();
    await svc(stub).list({ q: 'Smith, Inc (100%)_x' });
    // Spelled out: ',' '(' ')' '%' become spaces, then '_' is backslash-escaped
    // for ILIKE. Both terms reuse the SAME escaped string — there is no second,
    // raw interpolation path.
    expect(orFilterFor(stub)).toBe(
      'display_name.ilike.%Smith  Inc  100  \\_x%,file_name.ilike.%Smith  Inc  100  \\_x%',
    );
  });

  it('an empty search adds no filter at all (unchanged behavior)', async () => {
    const stub = stubFor();
    await svc(stub).list({ q: '   ' });
    expect(orFilterFor(stub)).toBeUndefined();
  });
});
