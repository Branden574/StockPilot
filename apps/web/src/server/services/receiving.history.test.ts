import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

/**
 * A purchase order's receipts for its page and its PDF (B67).
 *
 * Receiving is an optional module, and with it off `listForPurchaseOrder`
 * refuses (`module_disabled`, modules.gate.test.ts). The PO page awaited that
 * read beside the PO itself, so with Purchase orders on and Receiving off
 * every purchase order's page was "Something broke loading this page"; a
 * failed receipts read did the same with Receiving on. The PDF caught every
 * error and printed no receipts, reporting none of them.
 *
 * `historyForPurchaseOrder` is the one answer both now read: off (nothing is
 * read), ok, or failed (reported, never thrown). The strict
 * `listForPurchaseOrder` keeps its refusal for every other caller.
 */

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}), auditMany: vi.fn(async () => ({})) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReceivingService } from './receiving';

const ORG = '0a000000-0000-4000-8000-0000000000a1';
const PO = '0a000000-0000-4000-8000-0000000000b1';
const RECEIPT = '0a000000-0000-4000-8000-0000000000c1';
const RECEIVER = '0a000000-0000-4000-8000-0000000000d1';

type ResultMap = NonNullable<Parameters<typeof makeSupabaseStub>[0]>;

const ROWS: ResultMap = {
  'receipts.select': {
    data: [{ id: RECEIPT, receipt_number: 'RCV-0001', received_by: RECEIVER, status: 'posted' }],
    error: null,
  },
  'receipt_lines.select': {
    data: [{ id: 'rl-1', receipt_id: RECEIPT, item_id: 'item-1', qty_accepted_base: 4 }],
    error: null,
  },
  'user_profiles.select': {
    data: [{ id: RECEIVER, full_name: 'Sample Receiver', email: null }],
    error: null,
  },
};

function svc(receivingOn: boolean, results: ResultMap = ROWS) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  enabledModules.add('purchase_orders');
  if (receivingOn) enabledModules.add('receiving');
  else enabledModules.delete('receiving');
  const stub = makeSupabaseStub(results);
  const service = new ReceivingService(
    makeServiceContext(stub.client, { organizationId: ORG, enabledModules }),
  );
  return { stub, service };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReceivingService.historyForPurchaseOrder', () => {
  it('Receiving off: state off, nothing is read and nothing is reported', async () => {
    const { stub, service } = svc(false);
    await expect(service.historyForPurchaseOrder(PO)).resolves.toEqual({ state: 'off' });
    expect(stub.fromCalls).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a failed receipts read: state failed, reported once as a warning, never thrown', async () => {
    const { service } = svc(true, {
      ...ROWS,
      'receipts.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      },
    });
    const out = await service.historyForPurchaseOrder(PO);
    // Only the state: no message from the database travels to the page.
    expect(out).toEqual({ state: 'failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'receiving.po_history',
        level: 'warning',
        organizationId: ORG,
        extra: expect.objectContaining({ detail: expect.stringContaining('statement timeout') }),
      }),
    );
  });

  it('a failed page of receipt lines: state failed, reported', async () => {
    const { service } = svc(true, {
      ...ROWS,
      'receipt_lines.select': { data: null, error: { message: 'fetch failed' } },
    });
    await expect(service.historyForPurchaseOrder(PO)).resolves.toEqual({ state: 'failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'receiving.po_history', organizationId: ORG }),
    );
  });

  it('Receiving on: state ok with exactly what listForPurchaseOrder returns', async () => {
    const { service } = svc(true);
    const expected = await service.listForPurchaseOrder(PO);
    expect(expected.receipts).toHaveLength(1);
    expect(expected.lines).toHaveLength(1);
    await expect(service.historyForPurchaseOrder(PO)).resolves.toEqual({
      state: 'ok',
      ...expected,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('the strict listForPurchaseOrder still refuses when Receiving is off', async () => {
    const { service } = svc(false);
    await expect(service.listForPurchaseOrder(PO)).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

describe('no page or route reads receipts in a way that crashes when Receiving is off', () => {
  const APP = path.resolve(__dirname, '../../app');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('no file under app/ calls the strict listForPurchaseOrder()', () => {
    const offenders: string[] = [];
    let callers = 0;
    for (const file of files(APP)) {
      const code = readFileSync(file, 'utf8');
      if (!code.includes('ReceivingService')) continue;
      callers += 1;
      if (code.includes('.listForPurchaseOrder(')) offenders.push(path.relative(APP, file));
    }
    // Proves the scan saw the callers it polices: the PO page and its PDF.
    expect(callers).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
