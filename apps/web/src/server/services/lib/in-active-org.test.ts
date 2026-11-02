import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { ServiceError } from '../context';
import { readInActiveOrg } from './in-active-org';

/**
 * S39: the read every write keyed by a row id makes in the ACTIVE
 * organization before its function runs. A member of two organizations whose
 * page was left open after an organization switch sends the other
 * organization's id with this organization's context; the read finds no row
 * and refuses, so nothing runs and nothing is recorded here.
 */

const ROWS = [
  { id: 'row-a', organization_id: 'org-A', status: 'open' },
  { id: 'row-b', organization_id: 'org-B', status: 'open' },
];

function ctxIn(org: string, results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub(results);
  return { stub, ctx: makeServiceContext(stub.client, { organizationId: org }) };
}

describe('readInActiveOrg', () => {
  it("reads the row by organization and id, through the caller's client", async () => {
    const { stub, ctx } = ctxIn('org-A', { 'cycle_counts.select': servedLikePostgrest(ROWS) });

    const row = await readInActiveOrg(ctx, 'cycle_counts', 'row-a', 'Cycle count not found.');

    expect(row).toMatchObject({ id: 'row-a' });
    expect(stub.chains.get('cycle_counts.select')).toEqual(['select', 'eq', 'eq']);
    expect(stub.chainArgs.get('cycle_counts.select')).toEqual([
      ['id'],
      ['organization_id', 'org-A'],
      ['id', 'row-a'],
    ]);
  });

  it('selects the columns the caller asks for', async () => {
    const { stub, ctx } = ctxIn('org-A', { 'order_requests.select': servedLikePostgrest(ROWS) });

    const row = await readInActiveOrg<{ status: string }>(
      ctx,
      'order_requests',
      'row-a',
      'Order request not found',
      'status',
    );

    expect(row.status).toBe('open');
    expect(stub.chainArgs.get('order_requests.select')?.[0]).toEqual(['status']);
  });

  it("answers not_found in the caller's words for a row of another organization", async () => {
    const { ctx } = ctxIn('org-A', { 'bundles.select': servedLikePostgrest(ROWS) });

    const e = await readInActiveOrg(ctx, 'bundles', 'row-b', 'Bundle not found').catch((x) => x);

    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'not_found', message: 'Bundle not found' });
  });

  it('answers internal_error when the read fails, never not_found, and the write after it never runs', async () => {
    const { stub, ctx } = ctxIn('org-A', {
      'receipts.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
    });
    const write = async () => {
      await readInActiveOrg(ctx, 'receipts', 'row-a', 'Receipt not found.');
      await ctx.supabase.rpc('reverse_receipt', { p_receipt_id: 'row-a' });
    };

    const e = await write().catch((x) => x);

    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe('internal_error');
    // The raw text stays on the server (S13); the public message is generic.
    expect(e.internalDetail).toContain('statement timeout');
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses a missing row before the write after it runs', async () => {
    const { stub, ctx } = ctxIn('org-A', { 'stock_movements.select': servedLikePostgrest(ROWS) });
    const write = async () => {
      await readInActiveOrg(ctx, 'stock_movements', 'row-b', 'Movement not found.');
      await ctx.supabase.rpc('edit_movement_note', { p_movement_id: 'row-b' });
    };

    await expect(write()).rejects.toMatchObject({
      code: 'not_found',
      message: 'Movement not found.',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});
