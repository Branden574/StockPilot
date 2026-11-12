// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXPORT_FORBIDDEN_COPY,
  EXPORT_SESSION_ENDED_COPY,
  ExportRefusedError,
} from '@/lib/exports/export-refusal';

import { downloadInventoryExport, fetchExportPreview } from './download-export';

/**
 * B68: what a failed export or sample request throws, by what the server
 * answered.
 *
 * The export and its sample answered a member without items:export with a
 * bare 403 `{ error: 'forbidden' }`, and an ended session with a bare 401
 * `{ error: 'unauthenticated' }`. readError then threw the code itself, so the
 * dialog's alert line read "forbidden" or "unauthenticated", and the sample
 * filed the refusal as a passing failure ("You can still export the file.",
 * Try again). Both are now ExportRefusedError with a sentence, and no answer's
 * code is ever the text. Keyed on the code as well as the status: the export
 * limiter's cross_site_request and export.csv's module_disabled are 403s too,
 * and neither is about the permission.
 */

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const requests = [
  [
    'Export file (POST /api/inventory/export)',
    () => downloadInventoryExport({ format: 'csv', scope: 'all' }),
  ],
  ['the sample (POST /api/inventory/export/preview)', () => fetchExportPreview({ scope: 'all' })],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(requests)('%s: a refused or failed answer (B68)', (_label, send) => {
  /** What the request rejects with when the server answers `res`. */
  async function rejectionFor(res: Response): Promise<unknown> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    return send().then(
      () => {
        throw new Error('the request resolved; a failed answer must reject');
      },
      (e: unknown) => e,
    );
  }

  it('a 403 forbidden with no words is a refusal naming the permission, never the code', async () => {
    const e = await rejectionFor(jsonResponse({ error: 'forbidden' }, 403));
    expect(e).toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(EXPORT_FORBIDDEN_COPY);
    expect((e as Error).message).not.toMatch(/forbidden/i);
  });

  it.each([
    ['an empty message', { error: 'forbidden', message: '' }],
    ['a blank message', { error: 'forbidden', message: '   ' }],
    ['a message that is not text', { error: 'forbidden', message: 403 }],
  ])('a 403 forbidden with %s still says the sentence', async (_what, body) => {
    const e = await rejectionFor(jsonResponse(body, 403));
    expect(e).toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(EXPORT_FORBIDDEN_COPY);
  });

  it("a 403 forbidden with the server's own words keeps them, still a refusal", async () => {
    const words = 'You do not have permission to export the cost column.';
    const e = await rejectionFor(jsonResponse({ error: 'forbidden', message: words }, 403));
    expect(e).toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(words);
  });

  it('a 403 that is not about the permission (the limiter) keeps its words as a plain failure', async () => {
    const words = "Start this download from StockPilot. A link on another website can't start it.";
    const e = await rejectionFor(
      jsonResponse({ error: 'cross_site_request', message: words }, 403),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(words);
  });

  it('a 403 with another code and no words is a plain failure in plain words, never the code', async () => {
    const e = await rejectionFor(jsonResponse({ error: 'module_disabled' }, 403));
    expect(e).not.toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe('Export failed. Please try again.');
  });

  it('a 403 that is not JSON (an edge page) is a plain failure', async () => {
    const e = await rejectionFor(new Response('<html>Forbidden</html>', { status: 403 }));
    expect(e).not.toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe('Export failed. Please try again.');
  });

  it('a 401 is a refusal that says the session ended, never "unauthenticated"', async () => {
    const e = await rejectionFor(jsonResponse({ error: 'unauthenticated' }, 401));
    expect(e).toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(EXPORT_SESSION_ENDED_COPY);
    expect((e as Error).message).not.toMatch(/unauthenticated/i);
  });

  it('a 500 with only a code reads "Export failed. Please try again.", never the code', async () => {
    const e = await rejectionFor(jsonResponse({ error: 'internal_error' }, 500));
    expect(e).not.toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe('Export failed. Please try again.');
  });

  it("a 429 keeps the server's words, as before", async () => {
    const words = 'Too many exports — please wait a few minutes.';
    const e = await rejectionFor(jsonResponse({ error: 'rate_limited', message: words }, 429));
    expect(e).not.toBeInstanceOf(ExportRefusedError);
    expect((e as Error).message).toBe(words);
  });
});
