import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { extractIsbnsFromFile } from '@/lib/books/isbn-extract';
import { reportError } from '@/lib/error-reporter';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/books/isbn-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/books/isbn-extract')>();
  return { ...actual, extractIsbnsFromFile: vi.fn(actual.extractIsbnsFromFile) };
});

/**
 * POST /api/books/extract-isbns: the bulk ISBN import's text pass (S16). Its
 * catch answered every failure's own text with 400: the one sentence the
 * parser writes on purpose (an unsupported file type) and also whatever a
 * PDF, Word or Excel library threw. The sentence is now a ServiceError,
 * answered as it is and not reported; anything else is the fixed sentence,
 * and reported.
 */

function upload(name: string, type: string, body = 'ISBN 9780262033848') {
  const form = new FormData();
  form.append('file', new File([body], name, { type }));
  return new Request('https://test.local/api/books/extract-isbns', { method: 'POST', body: form });
}

describe('POST /api/books/extract-isbns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
    } as never);
  });

  it('reads the ISBNs from a text file', async () => {
    const res = await POST(upload('order.txt', 'text/plain'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kind: 'txt', isbns: ['9780262033848'] });
  });

  it('an unsupported file type is a 400 with its sentence, and is not reported', async () => {
    const res = await POST(upload('order.rtf', 'application/rtf'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'Unsupported file type. Accepted: PDF, Word (.docx), Excel (.xlsx/.xls), CSV, TXT.',
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a parser failure answers the fixed sentence, never the library's text, and is reported", async () => {
    const err = new Error(
      'Invalid PDF structure: bad XRef entry at /var/task/node_modules/pdfjs/build/pdf.js',
    );
    vi.mocked(extractIsbnsFromFile).mockRejectedValueOnce(err);
    const res = await POST(upload('order.pdf', 'application/pdf'));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Could not read this file. Try a different file.',
    });
    expect(text).not.toMatch(/XRef|node_modules/);
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'books.extract-isbns',
      organizationId: 'org-1',
      extra: { filename: 'order.pdf', size: 18 },
    });
  });
});
