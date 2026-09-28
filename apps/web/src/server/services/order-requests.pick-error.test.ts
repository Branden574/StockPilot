import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { INSUFFICIENT_PLACED_STOCK_COPY, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';

/**
 * F2-1: complete_picking's insufficient_placed_stock, in words that match the
 * draw engine (0373: racks, crates, Sites and Unplaced, never Staging). The
 * old sentence said Staging "or unplaced" stock blocks a pick; Unplaced does
 * not. The draw raises it with nothing in Staging too (on record more than
 * the locations hold), so the sentence names both causes and asserts neither.
 * The per-line list stays, with each line's owed units from core's
 * lineOwedUnits.
 */

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, { role: 'admin', enabledModules: new Set<ModuleId>(['orders']) }),
  );
}

describe('completePicking: insufficient_placed_stock', () => {
  it('names both causes (Staging, or on record more than the locations hold), never claims either, and lists the lines with what each still owes', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:complete_picking': {
        data: null,
        error: { message: 'insufficient_placed_stock', code: 'P0001' },
      },
      'order_request_lines.select': {
        data: [
          { quantity_requested: 10, quantity_fulfilled: 0, item: { name: 'Maus I', sku: 'MAUS-1' } },
          // over-fulfilled: owes 0, never a negative
          { quantity_requested: 5, quantity_fulfilled: 7, item: [{ name: 'Pens', sku: 'PEN-RG' }] },
        ],
        error: null,
      },
    });
    const err = await svc(stub)
      .completePicking('order-1')
      .then(
        () => null,
        (e: unknown) => e as { code: string; message: string },
      );
    expect(err?.code).toBe('validation_error');
    expect(err?.message).toBe(
      `${INSUFFICIENT_PLACED_STOCK_COPY} Lines on this order: Maus I (MAUS-1), 10 needed; Pens (PEN-RG), 0 needed.`,
    );
    expect(err?.message).toMatch(/never from Staging/);
    expect(err?.message).toContain('Sites and Unplaced');
    // It cannot know Staging holds anything (review 2026-09-28: a rack of 7
    // against 10 on record, nothing in Staging, raised this error).
    expect(err?.message).not.toMatch(/still in Staging/);
    expect(err?.message).toMatch(/count the item if its locations don't match its stock on record/);
  });

  it('still says what to do when the line list cannot be read', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:complete_picking': { data: null, error: { message: 'insufficient_placed_stock', code: 'P0001' } },
      'order_request_lines.select': { data: null, error: { message: 'timeout' } },
    });
    const err = await svc(stub)
      .completePicking('order-1')
      .then(
        () => null,
        (e: unknown) => e as { code: string; message: string },
      );
    expect(err).toMatchObject({ code: 'validation_error', message: INSUFFICIENT_PLACED_STOCK_COPY });
  });
});

describe('owed has one definition (pattern #26)', () => {
  it('order-requests.ts computes a line\'s owed units only through core lineOwedUnits', () => {
    const src = readFileSync(path.resolve(__dirname, 'order-requests.ts'), 'utf8');
    // The per-line inline copy the service used to carry in three places.
    expect(src).not.toMatch(
      /Math\.max\(\s*0\s*,\s*\(Number\(\w+\.quantity_requested\) \|\| 0\) - \(Number\(\w+\.quantity_fulfilled\) \|\| 0\)/,
    );
    expect(src).not.toMatch(/Math\.max\(0, quantity - \(Number\(line\.quantity_fulfilled\) \|\| 0\)\)/);
    expect((src.match(/lineOwedUnits\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(src).not.toContain('Not enough PUT-AWAY stock');
  });
});
