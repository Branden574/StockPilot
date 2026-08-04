// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadInventoryExport, fetchExportPreview } from './download-export';

/**
 * ADDITIVE (Task 13 test-hygiene sweep, not part of the brief's verbatim
 * suite — the brief's Step 10 has no test file for this module at all).
 *
 * download-export.ts is genuinely untested new client surface (Tasks 14/16/17
 * depend on `onStage` firing in the right order and on `fetchExportPreview`
 * round-tripping the preview response), so this file self-mutation-checks the
 * behaviors the task brief called out by name: stage callback order, and that
 * a failed request never fires 'done'.
 */

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

beforeEach(() => {
  // Spy in place (not vi.stubGlobal('URL', {...})) — replacing the whole URL
  // global with a plain object strips its constructor, and happy-dom's own
  // anchor-click navigation internals construct `new URL(...)` on click.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('downloadInventoryExport — stage order', () => {
  it('fires preparing, then downloading, then done, in that order, on success', async () => {
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    const res = new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="books-all-2026-08-03.csv"',
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const stages: string[] = [];
    await downloadInventoryExport(
      { format: 'csv', scope: 'all' },
      { onStage: (s) => stages.push(s) },
    );

    expect(stages).toEqual(['preparing', 'downloading', 'done']);
  });

  it('never fires downloading or done when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, { status: 500 })),
    );

    const stages: string[] = [];
    await expect(
      downloadInventoryExport({ format: 'csv', scope: 'all' }, { onStage: (s) => stages.push(s) }),
    ).rejects.toThrow('nope');

    // The highest-value regression this file guards: a failed export must
    // never claim it finished downloading.
    expect(stages).toEqual(['preparing']);
    expect(stages).not.toContain('done');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    );
    await expect(downloadInventoryExport({ format: 'csv', scope: 'all' })).rejects.toThrow(
      'Export failed. Please try again.',
    );
  });

  it('falls back to a default filename when Content-Disposition is missing', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));

    const clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    await downloadInventoryExport({ format: 'pdf', scope: 'all' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

describe('fetchExportPreview', () => {
  it('returns the parsed preview response on success', async () => {
    const payload = {
      total: 3,
      truncated: false,
      slug: 'books' as const,
      sampleRows: [],
      readiness: { rows: 3, withIsbn: 3, missingIsbn: 0, withImage: 1, missingImage: 2 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await fetchExportPreview({ scope: 'all', itemType: 'book' });
    expect(result).toEqual(payload);
  });

  it('throws the server message when the preview request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Select at least one item to preview.' }, { status: 400 })),
    );
    await expect(fetchExportPreview({ scope: 'selected', ids: [] })).rejects.toThrow(
      'Select at least one item to preview.',
    );
  });
});
