import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * audit().
 *
 * From the 443-item lab run:
 *  - audit() awaited the INSERT without reading `error`. supabase-js returns a
 *    failed request as { error } rather than throwing, so the catch never ran:
 *    runs wrote 274, 286 and 253 of 443 rows and nothing was reported.
 */

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  reportError: vi.fn(),
  withContext: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => {
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

import { audit, type AuditPayload } from './audit';
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
