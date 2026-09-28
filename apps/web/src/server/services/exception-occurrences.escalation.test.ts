import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * The occurrence read (the web list and detail, GET /api/v1/exceptions and
 * GET /api/v1/exceptions/[id]) carries the escalation (F1-5): the linked
 * request's id, number and handle for every reader of the occurrence, and,
 * on the detail, whether THIS reader can open the request and what it
 * records (a draft opened or not yet; cancelled). Honesty first: a failed
 * request read claims nothing.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: 0 })),
}));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] })),
    assertWarehouseAccess: vi.fn(async () => {}),
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: vi.fn(() => ({ createSignedUrls: vi.fn(async () => ({ data: [], error: null })) })) },
  })),
}));

import { ExceptionOccurrencesService } from './exception-occurrences';

const OCC = '11111111-1111-4111-8111-111111111111';
const REQ = '44444444-4444-4444-8444-444444444444';
const OLD_REQ = '55555555-5555-4555-8555-555555555555';
const WITH_MAINTENANCE = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);

/** Linked on Jan 1 2027, to a request created on Dec 31 2026 (UTC): the
 *  handle's year is the REQUEST's, as the request itself shows it. */
const ESCALATED = {
  maintenance_request_id: REQ,
  escalation_number: 14,
  escalation_request_created_at: '2026-12-31T23:59:59Z',
  escalated_at: '2027-01-01T00:00:01Z',
  escalated_by: 'user-2',
  escalator: { full_name: 'Pat Lee', email: 'pat@example.test' },
};

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 42,
    rule: 'label_mismatch',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: {},
    condition_since: null,
    first_seen_at: '2026-09-27T10:00:00Z',
    last_seen_at: '2026-09-27T10:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    maintenance_request_id: null,
    escalation_number: null,
    escalation_request_created_at: null,
    escalated_at: null,
    escalated_by: null,
    item: { name: 'Atlas', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    escalator: null,
    ...o,
  };
}

function request(o: Record<string, unknown> = {}) {
  return {
    id: REQ,
    request_number: 14,
    created_at: '2026-12-31T23:59:59Z',
    status: 'saved',
    cancelled_at: null,
    outlook_draft_opened_at: null,
    ...o,
  };
}

function event(id: string, kind: string, o: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    actor_user_id: 'user-2',
    cycle_count_id: null,
    evidence_id: null,
    maintenance_request_id: null,
    note: null,
    created_at: '2026-09-27T12:00:00Z',
    actor: { full_name: 'Pat Lee', email: null },
    ...o,
  };
}

function service(
  opts: {
    occurrence?: Record<string, unknown>;
    requests?: ReadonlyArray<Record<string, unknown>> | 'error';
    events?: ReadonlyArray<Record<string, unknown>>;
    modules?: Set<ModuleId>;
    permissions?: ReadonlySet<string>;
  } = {},
) {
  const row = opts.occurrence ?? occRow(ESCALATED);
  const stub = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': { data: row, error: null },
    'exception_occurrences.select': { data: [row], error: null },
    'exception_occurrence_events.select': { data: opts.events ?? [event('v1', 'raised', { actor_user_id: null })], error: null },
    'exception_sync_state.select.maybeSingle': { data: null, error: null },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
    'exception_evidence.select': { data: [], error: null },
    'maintenance_requests.select':
      opts.requests === 'error'
        ? { data: null, error: { message: 'requests read failed' } }
        : (call: MockCall) => {
            const ids = (call.args[call.methods.indexOf('in')]?.[1] as string[] | undefined) ?? [];
            const rows = (opts.requests ?? []) as ReadonlyArray<Record<string, unknown>>;
            return { data: rows.filter((r) => ids.includes(r.id as string)), error: null };
          },
  });
  const ctx = makeServiceContext(stub.client, {
    role: 'staff',
    enabledModules: opts.modules ?? WITH_MAINTENANCE,
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  });
  return { stub, svc: new ExceptionOccurrencesService(ctx as never) };
}

beforeEach(() => {
  reportError.mockClear();
});

describe('the list read: the escalation every reader sees', () => {
  it('carries the link, the MR handle (the request\'s own year), who and when; the request itself is not read', async () => {
    const { stub, svc } = service();
    const res = await svc.list({ status: 'open' });
    const o = res.occurrences[0]!;
    expect(o.escalation).toEqual({
      requestId: REQ,
      requestNumber: 14,
      reference: 'MR-2026-000014',
      escalatedAt: '2027-01-01T00:00:01Z',
      escalatedBy: { id: 'user-2', label: 'Pat Lee' },
      visibleToReader: null,
      request: null,
    });
    expect(stub.fromCalls).not.toContain('maintenance_requests');
    // Linked: no second escalation is offered from the list.
    expect(o.canEscalate).toBe(false);
    expect(o.escalateUnavailableReason).toBe('already_escalated');
    // The read asks for the escalation columns and names the escalator's key.
    const select = String(stub.chainArgs.get('exception_occurrences.select')?.[0]?.[0] ?? '');
    for (const col of ['maintenance_request_id', 'escalation_number', 'escalation_request_created_at', 'escalated_at', 'escalated_by']) {
      expect(select).toContain(col);
    }
    expect(select).toContain('escalator:user_profiles!exception_occurrences_escalated_by_fkey(full_name, email)');
  });

  it('never escalated: no escalation, and Escalate is offered to a member with the module and submit', async () => {
    const { svc } = service({ occurrence: occRow() });
    const o = (await svc.list({ status: 'open' })).occurrences[0]!;
    expect(o.escalation).toBeNull();
    expect(o.canEscalate).toBe(true);
    expect(o.escalateUnavailableReason).toBeNull();
  });

  it('why not: the module off, no submit permission, or a resolved row', async () => {
    const off = (await service({ occurrence: occRow(), modules: new Set<ModuleId>(DEFAULT_MODULE_IDS) }).svc.list()).occurrences[0]!;
    expect([off.canEscalate, off.escalateUnavailableReason]).toEqual([false, 'module_disabled']);
    const noSubmit = (
      await service({ occurrence: occRow(), permissions: new Set(['items:read', 'stock:adjust']) }).svc.list()
    ).occurrences[0]!;
    expect([noSubmit.canEscalate, noSubmit.escalateUnavailableReason]).toEqual([false, 'not_permitted']);
    const resolved = (
      await service({ occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }) }).svc.list({
        status: 'resolved',
      })
    ).occurrences[0]!;
    expect([resolved.canEscalate, resolved.escalateUnavailableReason]).toEqual([false, 'resolved']);
  });

  it('a request that was deleted (the link nulled, the number kept) still shows the handle, and may be escalated again', async () => {
    const { svc } = service({ occurrence: occRow({ ...ESCALATED, maintenance_request_id: null }) });
    const o = (await svc.list()).occurrences[0]!;
    expect(o.escalation?.reference).toBe('MR-2026-000014');
    expect(o.escalation?.requestId).toBeNull();
    expect(o.canEscalate).toBe(true);
  });
});

describe('the detail read: what THIS reader can see of the request', () => {
  it('a reader who can open it: visible, and what it records (a draft opened)', async () => {
    const { stub, svc } = service({ requests: [request({ status: 'draft_opened', outlook_draft_opened_at: '2026-09-27T12:05:00Z' })] });
    const d = await svc.get(OCC);
    expect(d.occurrence.escalation?.visibleToReader).toBe(true);
    expect(d.occurrence.escalation?.request).toEqual({ status: 'draft_opened', draftOpened: true, cancelled: false });
    expect(d.occurrence.canEscalate).toBe(false);
    // Read through the reader's own client, org-filtered, for exactly the linked request.
    const args = stub.chainArgs.get('maintenance_requests.select') ?? [];
    expect(args).toContainEqual(['organization_id', 'org-test']);
    expect(args).toContainEqual(['id', [REQ]]);
    expect(String(args[0]?.[0])).toBe('id, request_number, created_at, status, cancelled_at, outlook_draft_opened_at');
  });

  it('not yet opened reads as such', async () => {
    const { svc } = service({ requests: [request()] });
    const d = await svc.get(OCC);
    expect(d.occurrence.escalation?.request).toEqual({ status: 'saved', draftOpened: false, cancelled: false });
  });

  it('a reader who cannot open it: not visible, and nothing about the request is claimed', async () => {
    const { svc } = service({ requests: [] });
    const d = await svc.get(OCC);
    expect(d.occurrence.escalation?.visibleToReader).toBe(false);
    expect(d.occurrence.escalation?.request).toBeNull();
    expect(d.occurrence.escalation?.reference).toBe('MR-2026-000014');
    expect(d.occurrence.canEscalate).toBe(false);
  });

  it('a cancelled request the reader can see frees the occurrence: Escalate is offered again', async () => {
    const { svc } = service({ requests: [request({ status: 'cancelled', cancelled_at: '2026-09-27T13:00:00Z' })] });
    const d = await svc.get(OCC);
    expect(d.occurrence.escalation?.request?.cancelled).toBe(true);
    expect(d.occurrence.canEscalate).toBe(true);
    expect(d.occurrence.escalateUnavailableReason).toBeNull();
  });

  it('a failed request read is reported and claims nothing (not "not yet opened", not visible, not free)', async () => {
    const { svc } = service({ requests: 'error' });
    const d = await svc.get(OCC);
    expect(d.occurrence.escalation?.visibleToReader).toBeNull();
    expect(d.occurrence.escalation?.request).toBeNull();
    expect(d.occurrence.canEscalate).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalation_request_read' }),
    );
  });

  it('an occurrence never escalated reads no request at all', async () => {
    const { stub, svc } = service({ occurrence: occRow() });
    await svc.get(OCC);
    expect(stub.fromCalls).not.toContain('maintenance_requests');
  });

  it('timeline: an escalated event names the request when the reader knows it, and never more', async () => {
    const events = [
      event('v1', 'escalated', { maintenance_request_id: OLD_REQ, created_at: '2026-09-27T11:00:00Z' }),
      event('v2', 'escalated', { maintenance_request_id: REQ, created_at: '2026-09-27T12:00:00Z' }),
      event('v3', 'note', { maintenance_request_id: null, note: 'hi' }),
    ];
    // The reader can open neither request: the current link's handle comes
    // from the occurrence's copy; the earlier one stays unnamed.
    const hidden = await service({ events, requests: [] }).svc.get(OCC);
    expect(hidden.timeline.map((e) => e.maintenanceRequestReference)).toEqual([null, 'MR-2026-000014', null]);
    // A reader who can open the earlier request sees its own handle.
    const seen = await service({
      events,
      requests: [request(), request({ id: OLD_REQ, request_number: 9, created_at: '2026-05-01T00:00:00Z', cancelled_at: '2026-05-02T00:00:00Z', status: 'cancelled' })],
    }).svc.get(OCC);
    expect(seen.timeline.map((e) => e.maintenanceRequestReference)).toEqual(['MR-2026-000009', 'MR-2026-000014', null]);
  });
});
