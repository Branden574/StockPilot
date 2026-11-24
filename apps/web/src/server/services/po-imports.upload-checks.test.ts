import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): the PO import file (CSV or PDF, read
// at parse) and the PO scan frames go through the one upload check. A refusal
// is one malware / blocked event in the organization, with no file name; a
// refused import file is removed from storage and the import fails with the
// check's sentence; a clean file reaches the parser byte for byte as before.
// Tiny made-up files only.
// ---------------------------------------------------------------------------

const { mockAudit, mockParsePoFile, mockExtract, mockAdmin, adminRemove, mockUpload } = vi.hoisted(
  () => ({
    mockAudit: vi.fn(async (_event: unknown, _ctx?: unknown) => {}),
    mockParsePoFile: vi.fn(),
    mockExtract: vi.fn(),
    mockAdmin: vi.fn(),
    adminRemove: vi.fn(async (_paths: string[]) => ({ error: null })),
    mockUpload: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
  }),
);
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: mockParsePoFile }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: mockExtract, SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdmin }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { THREAT_MESSAGES } from '@/lib/document-threat-scan';
import { recordSecurityEvent } from '@/server/security/events';

import { PoImportsService } from './po-imports';

const record = vi.mocked(recordSecurityEvent);
const ORG = '11111111-1111-4111-8111-111111111111';
const IMPORT_ID = 'imp-checks-1';
const PATH = `${ORG}/po-imports/33333333-3333-4333-8333-333333333333`;

const enc = (s: string) => Buffer.from(s, 'latin1');

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.mockReturnValue({
    storage: { from: () => ({ remove: adminRemove, upload: mockUpload }) },
  });
  mockParsePoFile.mockResolvedValue({ lines: [], rawText: '' });
});

function parseStub(sourceType: 'pdf' | 'csv', body: Buffer) {
  const stub = makeSupabaseStub({
    'po_imports.select': {
      data: {
        id: IMPORT_ID,
        status: 'uploaded',
        source_type: sourceType,
        storage_path: `${PATH}.${sourceType}`,
        vendor_id: null,
      },
      error: null,
    },
    'po_imports.update': { data: { id: IMPORT_ID }, error: null },
  });
  const download = vi.fn(async () => ({
    data: { arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) },
    error: null,
  }));
  stub.client.storage.from = vi.fn(() => ({ download })) as never;
  return stub;
}

function failedWith(stub: ReturnType<typeof parseStub>): unknown {
  const updates = stub.chainArgsAll.get('po_imports.update') ?? [];
  return updates
    .map((args) => args[0]?.[0] as Record<string, unknown> | undefined)
    .find((u) => u?.status === 'failed')?.parse_error;
}

const svcFor = (stub: { client: unknown }) =>
  new PoImportsService(makeServiceContext(stub.client as never, { organizationId: ORG }) as never);

describe('PO import file at parse', () => {
  it('a clean CSV reaches the parser byte for byte, records nothing, removes nothing', async () => {
    const csv = enc('Item,Qty\r\nCafé,2\r\n'); // a single-byte code page letter is still text
    const stub = parseStub('csv', csv);
    await svcFor(stub).parseImport(IMPORT_ID);
    expect(mockParsePoFile).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(mockParsePoFile.mock.calls[0]![0] as Buffer, csv)).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(adminRemove).not.toHaveBeenCalled();
  });

  it('a clean PDF with a little leading junk still parses (the first-kilobyte rule is kept)', async () => {
    const pdf = enc('\r\n%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');
    const stub = parseStub('pdf', pdf);
    await svcFor(stub).parseImport(IMPORT_ID);
    expect(mockParsePoFile).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a binary file called .csv',
      'csv' as const,
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      'upload_wrong_type',
      'This file is not a CSV text file. Save it as CSV and upload it again.',
    ],
    ['a file that is not a PDF', 'pdf' as const, enc('just words'), 'upload_wrong_type', 'This file is not a PDF.'],
    [
      'a PDF with a script name in it',
      'pdf' as const,
      enc('%PDF-1.7\n1 0 obj\n<< /S /JavaScript >>\nendobj\n%%EOF\n'),
      'upload_active_content',
      THREAT_MESSAGES.pdf_javascript,
    ],
  ])('%s: refused before the parser, removed, one event, the sentence stored', async (_what, type, body, reason, sentence) => {
    const stub = parseStub(type, body);
    await svcFor(stub).parseImport(IMPORT_ID);
    expect(mockParsePoFile).not.toHaveBeenCalled();
    expect(failedWith(stub)).toBe(sentence);
    expect(adminRemove).toHaveBeenCalledWith([`${PATH}.${type}`]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toEqual({
      category: 'malware',
      outcome: 'blocked',
      reason,
      source: 'web',
      organizationId: ORG,
    });
    expect(JSON.stringify(record.mock.calls[0])).not.toContain('po-imports');
  });

  it('a recorder that fails: still refused, still removed', async () => {
    record.mockImplementationOnce(async () => {
      throw new Error('recorder down');
    });
    const stub = parseStub('csv', Buffer.from([0x00, 0x01, 0x02]));
    await svcFor(stub).parseImport(IMPORT_ID);
    expect(mockParsePoFile).not.toHaveBeenCalled();
    expect(adminRemove).toHaveBeenCalledTimes(1);
  });
});

describe('PO scan frames', () => {
  function scanSvc() {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: [], error: null },
      'po_imports.insert': { data: { id: IMPORT_ID }, error: null },
      'po_imports.update': { data: [], error: null },
    });
    return svcFor(stub);
  }

  it('a refused frame: one event, nothing stored, nothing sent to the model', async () => {
    await expect(
      scanSvc().createFromScan({
        files: [{ bytes: enc('<html>not a scan</html>'), mimeType: 'image/jpeg', fileName: 'secret-name.jpg' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ reason: 'upload_wrong_type', organizationId: ORG });
    expect(JSON.stringify(record.mock.calls[0])).not.toContain('secret-name');
  });

  it('a PDF frame with active content: active content, once', async () => {
    await expect(
      scanSvc().createFromScan({
        files: [
          {
            bytes: enc('%PDF-1.7\n1 0 obj\n<< /S /Launch >>\nendobj\n%%EOF\n'),
            mimeType: 'application/pdf',
            fileName: 'x.pdf',
          },
        ],
      }),
    ).rejects.toMatchObject({ message: THREAT_MESSAGES.pdf_launch_action });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ reason: 'upload_active_content' });
  });
});
