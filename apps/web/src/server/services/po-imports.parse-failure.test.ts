import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * A PO IMPORT THAT COULD NOT BE READ STORES THE APP'S WORDS (S31).
 *
 * parseImport stored the error's own text in po_imports.parse_error and the
 * audit's reason: Storage's words when the download failed, a PDF library's
 * when the file would not parse, 'not a PDF document' for bytes that were not
 * a PDF. The web and the phone show parse_error as it is. It is the app's
 * sentence now, and the library's or Storage's text is reported.
 */

const { mockAudit, mockParsePoFile, reportError } = vi.hoisted(() => ({
  mockAudit: vi.fn(async (_event: unknown, _ctx?: unknown) => {}),
  mockParsePoFile: vi.fn(),
  reportError: vi.fn(async (_error: unknown, _context?: unknown) => {}),
}));
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: mockParsePoFile }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-parse-fail-1';

function parseStub(opts: {
  sourceType: 'pdf' | 'csv';
  download: () => Promise<{ data: unknown; error: unknown }>;
}) {
  const stub = makeSupabaseStub({
    'po_imports.select': {
      data: {
        id: IMPORT_ID,
        status: 'uploaded',
        source_type: opts.sourceType,
        storage_path: `org-test/po-imports/imp.${opts.sourceType}`,
        vendor_id: null,
      },
      error: null,
    },
    'po_imports.update': { data: { id: IMPORT_ID }, error: null },
  });
  stub.client.storage.from = vi.fn(() => ({ download: vi.fn(opts.download) })) as never;
  return stub;
}

function bytes(text: string) {
  const buf = Buffer.from(text);
  return {
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** The `failed` update parseImport wrote, and the audit's reason. */
function stored(stub: ReturnType<typeof parseStub>) {
  const updates = stub.chainArgsAll.get('po_imports.update') ?? [];
  const failed = updates
    .map((args) => args[0]?.[0] as Record<string, unknown> | undefined)
    .find((u) => u?.status === 'failed');
  const auditCall = mockAudit.mock.calls.find(
    ([e]) => (e as { event: string }).event === 'po_import.failed',
  ) as unknown as [{ after: { reason: string } }] | undefined;
  return { parseError: failed?.parse_error, reason: auditCall?.[0].after.reason };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PoImportsService.parseImport stores the app's words for a file it could not read (S31)", () => {
  it('bytes that are not a PDF: "This file is not a PDF.", unreported', async () => {
    const stub = parseStub({
      sourceType: 'pdf',
      download: async () => ({ data: bytes('PK\u0003\u0004 a zip, not a pdf'), error: null }),
    });
    await new PoImportsService(makeServiceContext(stub.client) as never).parseImport(IMPORT_ID);
    expect(stored(stub)).toEqual({
      parseError: 'This file is not a PDF.',
      reason: 'This file is not a PDF.',
    });
    expect(mockParsePoFile).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a PDF the library could not read: the fixed sentence; the library's text only in the report", async () => {
    const libraryError = new Error('Invalid XRef stream header at offset 1834');
    mockParsePoFile.mockRejectedValueOnce(libraryError);
    const stub = parseStub({
      sourceType: 'pdf',
      download: async () => ({ data: bytes('%PDF-1.7\n1 0 obj\n'), error: null }),
    });
    await new PoImportsService(makeServiceContext(stub.client) as never).parseImport(IMPORT_ID);
    expect(stored(stub)).toEqual({
      parseError: 'The file could not be read. Upload it again as a PDF or CSV.',
      reason: 'The file could not be read. Upload it again as a PDF or CSV.',
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(libraryError, {
      tag: 'po_import.parse',
      organizationId: 'org-test',
      level: 'warning',
      extra: { importId: IMPORT_ID, sourceType: 'pdf' },
    });
  });

  it("a download Storage refused: the fixed sentence, never Storage's words", async () => {
    const stub = parseStub({
      sourceType: 'csv',
      download: async () => ({
        data: null,
        error: { message: 'Object not found in bucket po-imports' },
      }),
    });
    await new PoImportsService(makeServiceContext(stub.client) as never).parseImport(IMPORT_ID);
    const { parseError } = stored(stub);
    expect(parseError).toBe('The file could not be read. Upload it again as a PDF or CSV.');
    expect(JSON.stringify(stored(stub))).not.toContain('bucket');
    expect((vi.mocked(reportError).mock.calls[0]![0] as Error).message).toContain(
      'Object not found',
    );
  });
});
