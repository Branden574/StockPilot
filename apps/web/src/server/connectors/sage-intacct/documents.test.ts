import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ConnectionRef, ConnectorDeps } from '@stockpilot/core';

import type { IntacctClient } from './client';
import {
  buildIntacctPurchaseOrder,
  buildReturnJournalEntry,
  resolveIntacctVendor,
  round2,
} from './documents';

const CONN: ConnectionRef = {
  id: 'conn-1',
  organizationId: 'org-1',
  providerId: 'sage_intacct',
  status: 'active',
  externalAccountId: 'co-1',
  settings: {},
};

function makeDeps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return {
    admin: {},
    fetch,
    getMapping: vi.fn().mockResolvedValue(null),
    putMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildIntacctPurchaseOrder', () => {
  it('builds a single-line item-based document with the rounded total', () => {
    const body = buildIntacctPurchaseOrder({
      vendorId: 'V100',
      txnDefinition: 'Purchase Order',
      defaultItemId: 'NONINV',
      amount: 123.456,
      documentNumber: 'PO-42',
      date: '2026-06-12',
    });
    expect(body).toEqual({
      txnDefinition: { name: 'Purchase Order' },
      documentNumber: 'PO-42',
      createdDate: '2026-06-12',
      vendor: { id: 'V100' },
      lines: [{ item: { id: 'NONINV' }, quantity: 1, price: 123.46 }],
    });
  });
});

describe('buildReturnJournalEntry', () => {
  it('builds a balanced two-line entry (debit asset, credit return)', () => {
    const body = buildReturnJournalEntry({
      journalSymbol: 'GJ',
      returnCreditAccountId: '4900',
      inventoryAssetAccountId: '1200',
      lines: [
        { quantity: 2, unitCost: 10.005 },
        { quantity: 1, unitCost: 5 },
      ],
      postingDate: '2026-06-12',
      description: 'StockPilot return RET-9',
    });
    const lines = (body as { lines: Array<{ txnType: string; txnAmount: number; glAccount: { id: string } }> }).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ glAccount: { id: '1200' }, txnType: 'debit', txnAmount: 25.01 });
    expect(lines[1]).toEqual({ glAccount: { id: '4900' }, txnType: 'credit', txnAmount: 25.01 });
    // balanced by construction
    expect(lines[0]?.txnAmount).toBe(lines[1]?.txnAmount);
  });
});

describe('round2', () => {
  it('rounds to cents without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(2.675)).toBe(2.68);
  });
});

describe('resolveIntacctVendor', () => {
  const supplier = { id: 'sup-1', name: "O'Brien Supply" };

  it('returns the cached mapping without an API call', async () => {
    const deps = makeDeps({
      getMapping: vi.fn().mockResolvedValue({ externalId: 'V9', externalMeta: {} }),
    });
    const client = { queryPage: vi.fn() } as unknown as IntacctClient;
    const id = await resolveIntacctVendor(client, deps, CONN, supplier);
    expect(id).toBe('V9');
    expect((client as unknown as { queryPage: ReturnType<typeof vi.fn> }).queryPage).not.toHaveBeenCalled();
  });

  it('matches by exact name and persists the mapping', async () => {
    const deps = makeDeps();
    const client = {
      queryPage: vi.fn().mockResolvedValue({ records: [{ id: 'V100', name: supplier.name }], nextStart: null }),
    } as unknown as IntacctClient;
    const id = await resolveIntacctVendor(client, deps, CONN, supplier);
    expect(id).toBe('V100');
    expect(deps.putMapping).toHaveBeenCalledWith('conn-1', 'org-1', 'supplier', 'sup-1', 'V100');
    const call = (client as unknown as { queryPage: ReturnType<typeof vi.fn> }).queryPage.mock.calls[0]?.[0] as {
      filters: unknown[];
    };
    expect(call.filters).toEqual([{ $eq: { name: supplier.name } }]);
  });

  it('returns null (NEVER creates) when no vendor matches', async () => {
    const deps = makeDeps();
    const client = {
      queryPage: vi.fn().mockResolvedValue({ records: [], nextStart: null }),
      post: vi.fn(),
    } as unknown as IntacctClient;
    const id = await resolveIntacctVendor(client, deps, CONN, supplier);
    expect(id).toBeNull();
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).not.toHaveBeenCalled();
    expect(deps.putMapping).not.toHaveBeenCalled();
  });
});
