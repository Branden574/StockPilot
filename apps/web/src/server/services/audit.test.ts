import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * audit() and auditMany().
 *
 * Two defects from the 443-item lab run:
 *  - bulk Set rack fired one `void audit()` per item, 443 INSERTs at once; the
 *    gateway answered 190 of them 502 and the bulk op's next read failed too.
 *    auditMany writes the same rows 100 per INSERT, at most 2 in flight.
 *  - audit() awaited the INSERT without reading `error`. supabase-js returns a
 *    failed request as { error } rather than throwing, so the catch never ran:
 *    runs wrote 274, 286 and 253 of 443 rows and nothing was reported.
 */

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  headersCalls: 0,
  reportError: vi.fn(),
  withContext: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    h.headersCalls += 1;
    const values: Record<string, string> = {
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'lab-agent/1.0',
    };
    return { get: (k: string) => values[k] ?? null };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: h.insert }) }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('./context', () => ({ withContext: h.withContext }));
// src/test/setup.ts stubs this module for every other test; this file tests
// the real one.
vi.unmock('@/server/services/audit');

import {
  audit,
  AUDIT_INSERT_BATCH_ROWS,
  AUDIT_INSERT_CONCURRENCY,
  auditMany,
  type AuditPayload,
} from './audit';
import type { ServiceContext } from './context';

const ctx = { organizationId: 'org-1', userId: 'user-1' } as unknown as ServiceContext;

const SECRET_NAME = 'Item name that must never reach a report';

function payload(i: number): AuditPayload {
  return {
    event: 'inventory.item.updated',
    entityType: 'inventory_item',
    entityId: `item-${i}`,
    before: { bin_location: SECRET_NAME },
    after: { bin_location: '947-Q' },
    extra: { bulk_op: 'set_rack', changed_keys: ['bin_location'] },
  };
}

const ok = { error: null, status: 201, statusText: 'Created' };
const badGateway = { error: { message: '', code: '' }, status: 502, statusText: 'Bad Gateway' };

beforeEach(() => {
  h.insert.mockReset();
  h.reportError.mockReset();
  h.withContext.mockReset();
  h.headersCalls = 0;
});

describe('audit()', () => {
  it('reports a refused INSERT with the event and the status, never the row', async () => {
    h.insert.mockResolvedValue(badGateway);
    await audit(payload(1), ctx);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [, report] = h.reportError.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'audit.write_failed',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 1, status: 502 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SECRET_NAME);
  });

  it('writes the row it has always written: user, IP, user agent, event and metadata', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(7), ctx);
    expect(h.insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      user_id: 'user-1',
      event: 'inventory.item.updated',
      ip: '203.0.113.7',
      user_agent: 'lab-agent/1.0',
      metadata: {
        entity_type: 'inventory_item',
        entity_id: 'item-7',
        warehouse_id: null,
        before: { bin_location: SECRET_NAME },
        after: { bin_location: '947-Q' },
        reason: null,
        bulk_op: 'set_rack',
        changed_keys: ['bin_location'],
      },
    });
  });

  it('reports nothing when the row is written', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('never throws, even when the INSERT itself rejects', async () => {
    h.insert.mockRejectedValue(new TypeError('fetch failed'));
    await expect(audit(payload(1), ctx)).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

describe('auditMany()', () => {
  it('writes 443 rows in INSERTs of 100 with at most 2 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    h.insert.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return ok;
    });
    const payloads = Array.from({ length: 443 }, (_, i) => payload(i));
    const res = await auditMany(payloads, ctx);

    expect(res).toEqual({ written: 443, lost: 0 });
    expect(AUDIT_INSERT_BATCH_ROWS).toBe(100);
    expect(AUDIT_INSERT_CONCURRENCY).toBe(2);
    expect(h.insert.mock.calls.map(([rows]) => (rows as unknown[]).length)).toEqual([
      100, 100, 100, 100, 43,
    ]);
    expect(peak).toBe(2);
    // The request headers are read once for the whole batch.
    expect(h.headersCalls).toBe(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('writes exactly the row audit() writes for the same payload', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(7), ctx);
    const single = h.insert.mock.calls[0]![0];
    h.insert.mockClear();

    await auditMany([payload(7)], ctx);
    const [batch] = h.insert.mock.calls[0]! as [unknown[]];
    expect(batch).toEqual([single]);
  });

  it('keeps writing after a failed chunk and reports how many rows were lost', async () => {
    let n = 0;
    h.insert.mockImplementation(async () => {
      n += 1;
      if (n === 2) return badGateway;
      if (n === 4) throw new TypeError('fetch failed');
      return ok;
    });
    const payloads = Array.from({ length: 443 }, (_, i) => payload(i));
    const res = await auditMany(payloads, ctx);

    expect(h.insert).toHaveBeenCalledTimes(5);
    expect(res).toEqual({ written: 243, lost: 200 });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [, report] = h.reportError.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'audit.write_failed',
      level: 'warning',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 200, total: 443, status: 502 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SECRET_NAME);
  });

  it('reports every row as lost when the context cannot be read, and never throws', async () => {
    h.withContext.mockRejectedValue(new Error('no session'));
    const res = await auditMany([payload(1), payload(2)]);
    expect(res).toEqual({ written: 0, lost: 2 });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({ extra: { lost: 2, total: 2 } });
  });

  it('does nothing for an empty list', async () => {
    const res = await auditMany([], ctx);
    expect(res).toEqual({ written: 0, lost: 0 });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.headersCalls).toBe(0);
  });
});
