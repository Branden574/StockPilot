import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PO-number RPC must never fail SILENTLY again.
 *
 * THE INCIDENT (found 2026-09-06 while pushing 0350): next_po_number was
 * missing from PRODUCTION from 2026-05-20 onward — migration 0005 created it
 * everywhere else, so a local `supabase db reset` always had it and no test
 * ever noticed. Both callers destructured only `{ data }`, so the 42883 was
 * discarded and the code fell through to `PO-${Date.now()}`. Result: 27
 * production purchase orders numbered like PO-1788277456195, on
 * supplier-facing documents, for three and a half months, with ZERO of the
 * intended PO-YYYY-NNNN shape and no error anywhere to explain it.
 *
 * The fallback is correct and stays — a PO must always get a number — but it
 * is now reported. These tests pin the reporting, because the fallback itself
 * is what made the bug invisible.
 */

const reportError = vi.fn(async () => undefined);
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

const SOURCES = [
  'src/server/services/purchase-orders.ts',
  'src/server/services/po-imports.ts',
] as const;

beforeEach(() => vi.clearAllMocks());

describe('next_po_number callers report a failing RPC', () => {
  it.each(SOURCES)('%s destructures the rpc error and reports it', async (rel) => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(process.cwd(), rel), 'utf8');

    const at = src.indexOf("rpc(\n      'next_po_number'") >= 0
      ? src.indexOf("rpc(\n      'next_po_number'")
      : src.indexOf("'next_po_number'");
    expect(at, `${rel}: next_po_number call not found`).toBeGreaterThan(-1);
    const window = src.slice(at - 400, at + 900);

    // The error must be destructured, not dropped.
    expect(window, `${rel}: rpc error is discarded`).toMatch(/error:\s*\w*(Err|Error)/);
    // ...and actually reported.
    expect(window, `${rel}: failure is not reported`).toMatch(/reportError\(/);
    // ...while the fallback survives, because a PO must always get a number.
    expect(window, `${rel}: the fallback was removed`).toMatch(/PO-\$\{Date\.now\(\)\}/);
  });

  it('both callers import the reporter they use', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    for (const rel of SOURCES) {
      const src = readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      expect(src, `${rel}`).toMatch(/import \{ reportError \} from '@\/lib\/error-reporter'/);
    }
  });
});
