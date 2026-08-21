import { deflateSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// THE PATH THAT WAS MISSED — createFromScan, 2026-08-21
//
// Every other upload surface was closed against declared-type spoofing in the
// byte-verification wave. This one was not: it validated `mimeType` — the
// caller's word — and then let that same word decide the Content-Type written
// into the po-imports object with the SERVICE-ROLE client, the media type
// handed to the vision model, and the file_mime_type recorded on the row.
// Nothing anywhere opened the file.
//
// It is the worst of the surfaces to have missed, because the bytes go two
// places at once: into storage, where they can later be signed and served, and
// out to an external AI provider.
//
// The tests below assert the three properties that fix has to hold:
//   1. bytes that are not what they claim are REFUSED;
//   2. a real document carrying active content is REFUSED;
//   3. what gets recorded and forwarded is the SNIFFED type, not the claim —
//      because merely validating the declared value still leaves it flowing
//      downstream past a check it never satisfied.
// ---------------------------------------------------------------------------

const { mockAudit, mockExtract, mockAdmin, mockUpload } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockExtract: vi.fn(),
  mockAdmin: vi.fn(),
  // Typed with its real arg list so the assertion on the upload OPTIONS
  // (the third argument, carrying contentType) can reach them.
  mockUpload: vi.fn(
    async (_path: string, _body: unknown, _opts?: { contentType?: string; upsert?: boolean }) => ({
      data: { path: 'p' },
      error: null,
    }),
  ),
}));

vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({
  extractPoFromMedia: mockExtract,
  SCAN_MODEL_NAME: 'claude-sonnet-5',
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdmin }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-bytes-1';

/** A real, complete JPEG: SOI, one SOF0 carrying dimensions, EOI. */
const REAL_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00, 0xff, 0xd9,
]);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.mockReturnValue({
    storage: { from: () => ({ upload: mockUpload, remove: vi.fn(async () => ({ error: null })) }) },
  });
  mockExtract.mockResolvedValue({
    poNumber: 'PO-1',
    vendorName: 'Acme',
    vendorAddress: '',
    orderDate: '',
    expectedDate: '',
    subtotal: 0,
    tax: 0,
    freight: 0,
    grandTotal: 0,
    overallConfidence: 0.9,
    lines: [],
  });
});

function svc() {
  const stub = makeSupabaseStub({
    'po_imports.select': { data: [], error: null },
    'po_imports.insert': { data: { id: IMPORT_ID }, error: null },
    'po_imports.update': { data: [], error: null },
    'purchase_orders.select': { data: [], error: null },
    'vendor_item_mappings.select': { data: [], error: null },
    'po_import_lines.insert': { data: null, error: null },
  });
  const ctx = makeServiceContext(stub.client, { role: 'admin' });
  return { service: new PoImportsService(ctx), stub };
}

function insertedRow(stub: ReturnType<typeof svc>['stub']): Record<string, unknown> {
  return (stub.chainArgs.get('po_imports.insert')?.[0]?.[0] ?? {}) as Record<string, unknown>;
}

describe('createFromScan — the bytes get the last word', () => {
  it('REFUSES bytes that are not the type they claim', async () => {
    const { service } = svc();
    await expect(
      service.createFromScan({
        files: [
          {
            bytes: Uint8Array.from(ascii('<html><script>alert(1)</script></html>')),
            mimeType: 'image/jpeg',
            fileName: 'invoice.jpg',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // NOTHING was spent and nothing was written. The check has to sit ahead of
    // both, or a rejected file still costs a vision call and leaves an object.
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('REFUSES a genuine PDF that carries active content', async () => {
    // This one really IS a PDF — it passes every byte-signature check there
    // is. What makes it unacceptable is what it does when opened, which is a
    // different question and needs a different check.
    const { service } = svc();
    const malicious = Uint8Array.from(
      ascii('%PDF-1.7\n1 0 obj\n<< /OpenAction << /S /Launch /F (calc.exe) >> >>\nendobj\n%%EOF\n'),
    );
    await expect(
      service.createFromScan({
        files: [{ bytes: malicious, mimeType: 'application/pdf', fileName: 'invoice.pdf' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('REFUSES active content hidden in a compressed stream', async () => {
    // The shape every real PDF producer emits, and the one a scanner that only
    // greps raw bytes cannot see. Pinned here and not only in the scanner's own
    // suite, because this is the path where the file also goes to an AI
    // provider — the seam is worth asserting end to end.
    const { service } = svc();
    const deflated = deflateSync(Buffer.from('<< /S /JavaScript /JS (x) >>', 'latin1'));
    const hidden = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(deflated),
      ascii('\nendstream\n%%EOF\n'),
    );
    expect(Buffer.from(hidden).toString('latin1')).not.toContain('JavaScript');
    await expect(
      service.createFromScan({
        files: [{ bytes: hidden, mimeType: 'application/pdf', fileName: 'invoice.pdf' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('records and forwards the SNIFFED type, discarding the declared one', async () => {
    // A real JPEG announced as a PDF. Validating the claim and keeping it would
    // have stored `application/pdf` on a JPEG object and told the vision model
    // to read it as a PDF; the declared value has to be REPLACED, not merely
    // checked.
    const { service, stub } = svc();
    await service.createFromScan({
      files: [{ bytes: REAL_JPEG, mimeType: 'application/pdf', fileName: 'invoice.pdf' }],
    });

    expect(insertedRow(stub).file_mime_type).toBe('image/jpeg');
    expect(mockUpload.mock.calls[0]?.[2]).toMatchObject({ contentType: 'image/jpeg' });
    expect(mockExtract.mock.calls[0]?.[0]?.[0]).toMatchObject({ mimeType: 'image/jpeg' });
    // …and the extension follows the bytes too, so the object is not named .pdf
    expect(String(insertedRow(stub).storage_path)).toMatch(/\.jpg$/);
  });

  it('accepts an ordinary scanned purchase order', async () => {
    // The check earns nothing if it also refuses the real thing.
    const { service } = svc();
    const ordinary = Uint8Array.from(
      ascii(
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] >>\nendobj\n%%EOF\n',
      ),
    );
    await expect(
      service.createFromScan({
        files: [{ bytes: ordinary, mimeType: 'application/pdf', fileName: 'po.pdf' }],
      }),
    ).resolves.toMatchObject({ id: IMPORT_ID });
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });
});
