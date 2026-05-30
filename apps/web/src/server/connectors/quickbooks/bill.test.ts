import { describe, expect, it, vi } from 'vitest';

import type { ConnectionRef, ConnectorDeps } from '@stockpilot/core';

import { buildBillFromReceipt, resolveVendor } from './bill';
import type { QboClient } from './client';

describe('buildBillFromReceipt', () => {
  it('builds a one-line AccountBasedExpenseLineDetail Bill with Amount = Σ qty×cost (2-dp)', () => {
    const body = buildBillFromReceipt({
      vendorId: 'v-1',
      billExpenseAccountId: 'acct-9',
      lines: [{ qtyAccepted: 5, unitCost: 2 }],
    });

    expect(body).toEqual({
      VendorRef: { value: 'v-1' },
      Line: [
        {
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: 10,
          AccountBasedExpenseLineDetail: { AccountRef: { value: 'acct-9' } },
        },
      ],
    });
  });

  it('sums multiple lines and rounds the aggregate Amount to 2 decimal places', () => {
    const body = buildBillFromReceipt({
      vendorId: 'v-2',
      billExpenseAccountId: 'acct-1',
      lines: [
        { qtyAccepted: 3, unitCost: 1.115 }, // 3.345
        { qtyAccepted: 2, unitCost: 0.1 }, // 0.2
      ],
    });

    // 3.345 + 0.2 = 3.545 -> round2 -> 3.55 (proves a single aggregate line + round2)
    expect(body.Line).toHaveLength(1);
    const line = body.Line[0]!;
    expect(line.Amount).toBe(3.55);
    expect(line.AccountBasedExpenseLineDetail.AccountRef.value).toBe('acct-1');
  });
});

describe('resolveVendor', () => {
  const conn: ConnectionRef = {
    id: 'conn-1',
    organizationId: 'org-1',
    providerId: 'quickbooks',
    status: 'active',
    externalAccountId: 'realm-1',
    settings: {},
  };

  function makeDeps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
    return {
      admin: {},
      fetch,
      getMapping: vi.fn(async () => null),
      putMapping: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('returns the mapped external id on a mapping hit without calling QBO', async () => {
    const deps = makeDeps({
      getMapping: vi.fn(async () => ({ externalId: 'qbo-vendor-42', externalMeta: {} })),
    });
    const client = {
      query: vi.fn(),
      post: vi.fn(),
    } as unknown as QboClient;

    const id = await resolveVendor(client, deps, conn, { id: 'sup-1', name: 'Acme' });

    expect(id).toBe('qbo-vendor-42');
    expect(deps.getMapping).toHaveBeenCalledWith('conn-1', 'supplier', 'sup-1');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(deps.putMapping).not.toHaveBeenCalled();
  });

  it('on a miss with no existing Vendor: creates the Vendor and persists the mapping', async () => {
    const deps = makeDeps();
    const query = vi.fn(async () => ({ QueryResponse: {} }));
    const post = vi.fn(async () => ({ Vendor: { Id: 'qbo-new-7' } }));
    const client = { query, post } as unknown as QboClient;

    const id = await resolveVendor(client, deps, conn, { id: 'sup-2', name: "O'Reilly" });

    expect(id).toBe('qbo-new-7');
    // single-quote escaped in the query
    expect(query).toHaveBeenCalledWith(
      "select * from Vendor where DisplayName = 'O''Reilly'",
    );
    expect(post).toHaveBeenCalledWith('/vendor', { DisplayName: "O'Reilly" }, expect.any(String));
    expect(deps.putMapping).toHaveBeenCalledWith(
      'conn-1',
      'org-1',
      'supplier',
      'sup-2',
      'qbo-new-7',
    );
  });

  it('on a miss with an existing QBO Vendor by name: reuses it and persists the mapping (no create)', async () => {
    const deps = makeDeps();
    const query = vi.fn(async () => ({ QueryResponse: { Vendor: [{ Id: 'qbo-existing-3' }] } }));
    const post = vi.fn();
    const client = { query, post } as unknown as QboClient;

    const id = await resolveVendor(client, deps, conn, { id: 'sup-3', name: 'Globex' });

    expect(id).toBe('qbo-existing-3');
    expect(post).not.toHaveBeenCalled();
    expect(deps.putMapping).toHaveBeenCalledWith(
      'conn-1',
      'org-1',
      'supplier',
      'sup-3',
      'qbo-existing-3',
    );
  });
});
