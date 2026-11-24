import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeSupabaseStub } from '@/test/supabase-mock';
import {
  arrayBufferOf,
  ascii,
  DOCX_WITH_MACRO_PART,
  expectOneRefusal,
  HTML_PAGE,
  PDF_WITH_SCRIPT,
  TINY_DOCX,
  TINY_JPEG,
  TINY_PDF,
  TINY_XLSX,
} from '@/test/upload-fixtures';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): both ISBN extractors (the text pass,
// POST /api/books/extract-isbns, and the AI pass, POST /api/books/
// extract-isbns-ai) take a file's kind from its BYTES through the one upload
// check before any parser or model reads it. The name only CLAIMS a kind: the
// bytes must be that kind. A Word or Excel container with a macro part, or
// whose parts are the other program's, is refused; text with binary bytes is
// refused. A refusal is a 400 with a plain sentence, nothing parsed or sent,
// and exactly one malware / blocked event in the organization with no file
// name. A clean file reaches the parser or the model byte for byte, and the
// model is told the type the bytes are. Tiny made-up files only.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  extractFromFile: vi.fn(),
  aiFromBuffer: vi.fn(),
  aiFromText: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/books/isbn-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/books/isbn-extract')>();
  return { ...actual, extractIsbnsFromFile: h.extractFromFile };
});
vi.mock('@/lib/books/isbn-ai-extract', () => ({
  aiExtractIsbnsFromBuffer: h.aiFromBuffer,
  aiExtractIsbns: h.aiFromText,
}));

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { recordSecurityEvent } from '@/server/security/events';
import { UPLOAD_REFUSED_MESSAGE } from '@/server/security/upload-checks';

import { POST as textPass } from '@/app/api/books/extract-isbns/route';
import { POST as aiPass } from '@/app/api/books/extract-isbns-ai/route';

const record = vi.mocked(recordSecurityEvent);
const ORG = '11111111-1111-4111-8111-111111111111';
/** Part of every file name: never in what is recorded. */
const SECRET = 'order-sheet-of-a-secret-school';

function upload(route: string, name: string, type: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([arrayBufferOf(bytes)], `${SECRET}.${name}`, { type }));
  return new Request(`https://test.local/api/books/${route}`, { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  record.mockImplementation(async () => undefined);
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: ORG,
    userId: 'u-1',
    role: 'staff' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['ai', 'inventory', 'books']),
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 } as never);
  h.extractFromFile.mockResolvedValue({ kind: 'txt', isbns: [], empty: true });
  h.aiFromBuffer.mockResolvedValue({ isbns: [], candidates: [], notes: null });
  h.aiFromText.mockResolvedValue({ isbns: [], candidates: [], notes: null });
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('the text pass', () => {
  it.each([
    ['a CSV', 'csv', 'text/csv', ascii('isbn\n9780306406157\n')],
    ['a PDF', 'pdf', 'application/pdf', TINY_PDF],
    ['a Word file', 'docx', DOCX, TINY_DOCX],
    ['an Excel file', 'xlsx', XLSX, TINY_XLSX],
  ])('%s reaches the parser byte for byte, recording nothing', async (_what, ext, type, bytes) => {
    const res = await textPass(upload('extract-isbns', ext, type, bytes));
    expect(res.status).toBe(200);
    expect(h.extractFromFile).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(h.extractFromFile.mock.calls[0]![0] as Buffer, Buffer.from(bytes))).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a PDF', 'pdf', 'application/pdf', HTML_PAGE, 'upload_wrong_type', 'This file is not a PDF we can read. Save it as a PDF and upload it again.'],
    ['a PDF with a script name in it', 'pdf', 'application/pdf', PDF_WITH_SCRIPT, 'upload_active_content', UPLOAD_REFUSED_MESSAGE],
    ['a Word file with a macro part', 'docx', DOCX, DOCX_WITH_MACRO_PART, 'upload_active_content', UPLOAD_REFUSED_MESSAGE],
    ['an Excel file called a Word file', 'docx', DOCX, TINY_XLSX, 'upload_wrong_type', 'This file is not a Word document we can read. Save it as .docx and upload it again.'],
    ['a binary file called a CSV', 'csv', 'text/csv', Uint8Array.from([0x00, 0x01, 0x02, 0x03]), 'upload_wrong_type', 'This file is not plain text. Save it as CSV or TXT and upload it again.'],
  ])('%s: 400 with a plain sentence, never parsed, one event without the name', async (_what, ext, type, bytes, reason, sentence) => {
    const res = await textPass(upload('extract-isbns', ext, type, bytes));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_error', message: sentence });
    expect(h.extractFromFile).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason, organizationId: ORG }, [SECRET]);
  });

  it('a name we have no parser for is the parser\'s own sentence, with nothing judged or recorded', async () => {
    h.extractFromFile.mockImplementationOnce(async () => {
      const { ServiceError } = await import('@/server/services/context');
      throw new ServiceError('validation_error', 'Unsupported file type.');
    });
    const res = await textPass(upload('extract-isbns', 'rtf', 'application/rtf', HTML_PAGE));
    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('a recorder that fails: the refusal stands', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    expect((await textPass(upload('extract-isbns', 'pdf', 'application/pdf', HTML_PAGE))).status).toBe(400);
    expect(h.extractFromFile).not.toHaveBeenCalled();
  });
});

describe('the AI pass', () => {
  it('a JPEG named and declared as a PNG reaches the model byte for byte, as a JPEG', async () => {
    const res = await aiPass(upload('extract-isbns-ai', 'png', 'image/png', TINY_JPEG));
    expect(res.status).toBe(200);
    const [bytes, mime] = h.aiFromBuffer.mock.calls[0]! as [Buffer, string];
    expect(mime).toBe('image/jpeg');
    expect(Buffer.compare(bytes, Buffer.from(TINY_JPEG))).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a photo', 'png', 'image/png', HTML_PAGE, 'upload_wrong_type'],
    ['a Word file with a macro part', 'docx', DOCX, DOCX_WITH_MACRO_PART, 'upload_active_content'],
    ['a PDF with a script name in it', 'pdf', 'application/pdf', PDF_WITH_SCRIPT, 'upload_active_content'],
  ])('%s: 400, nothing sent to the model, one event without the name', async (_what, ext, type, bytes, reason) => {
    const res = await aiPass(upload('extract-isbns-ai', ext, type, bytes));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('validation_error');
    expect(h.aiFromBuffer).not.toHaveBeenCalled();
    expect(h.aiFromText).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason, organizationId: ORG }, [SECRET]);
  });

  it('a recorder that fails: the refusal stands', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    expect((await aiPass(upload('extract-isbns-ai', 'png', 'image/png', HTML_PAGE))).status).toBe(400);
    expect(h.aiFromBuffer).not.toHaveBeenCalled();
  });
});
