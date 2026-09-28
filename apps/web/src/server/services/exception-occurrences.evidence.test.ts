import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The occurrence read (GET /api/v1/exceptions/[id], the phone's detail, and
 * the web detail) carries the photo evidence (F1-4). Honesty first: a photo
 * read or a signing that fails is `unavailable`, never an empty gallery, and
 * it does not take the rest of the detail down with it.
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
    getWarehouseAccess: vi.fn(async () => ({
      hasAllAccess: false,
      readableIds: ['wh-a'],
      writableIds: ['wh-a'],
    })),
    assertWarehouseAccess: vi.fn(async () => {}),
  };
});
const signing = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        createSignedUrls: vi.fn(async (paths: string[]) =>
          signing.fail
            ? { data: null, error: { message: 'storage down' } }
            : {
                data: paths.map((path) => ({
                  path,
                  signedUrl: `https://signed/${path}`,
                  error: null,
                })),
                error: null,
              },
        ),
      })),
    },
  })),
}));

import { ExceptionOccurrencesService } from './exception-occurrences';

const OCC = '11111111-1111-4111-8111-111111111111';

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 5,
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
    item: { name: 'Atlas', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

const EV_ROWS = [
  {
    id: 'e1',
    uploaded_by: 'user-test',
    storage_path: `org/${OCC}/e1.jpg`,
    thumbnail_path: `org/${OCC}/e1-thumb.webp`,
    content_type: 'image/jpeg',
    byte_size: 2048,
    captured_at: '2026-09-27T11:50:00Z',
    note: 'shelf empty',
    created_at: '2026-09-27T12:00:00Z',
    removed_at: null,
    removed_by: null,
    uploader: { full_name: 'Test User', email: 't@x.test' },
  },
  {
    id: 'e2',
    uploaded_by: 'user-test',
    storage_path: `org/${OCC}/e2.jpg`,
    thumbnail_path: null,
    content_type: 'image/jpeg',
    byte_size: 1024,
    captured_at: null,
    note: null,
    created_at: '2026-09-27T12:05:00Z',
    removed_at: '2026-09-27T12:10:00Z',
    removed_by: 'user-test',
    uploader: { full_name: 'Test User', email: 't@x.test' },
  },
];

const EVENTS = [
  {
    id: 'v1',
    kind: 'raised',
    actor_user_id: null,
    cycle_count_id: null,
    evidence_id: null,
    maintenance_request_id: null,
    note: null,
    created_at: '2026-09-27T10:00:00Z',
  },
  {
    id: 'v2',
    kind: 'evidence_added',
    actor_user_id: 'user-test',
    cycle_count_id: null,
    evidence_id: 'e1',
    maintenance_request_id: null,
    note: 'shelf empty',
    created_at: '2026-09-27T12:00:00Z',
    actor: { full_name: 'Test User', email: null },
  },
  {
    id: 'v3',
    kind: 'evidence_added',
    actor_user_id: 'user-test',
    cycle_count_id: null,
    evidence_id: 'e2',
    maintenance_request_id: null,
    note: null,
    created_at: '2026-09-27T12:05:00Z',
    actor: { full_name: 'Test User', email: null },
  },
  {
    id: 'v4',
    kind: 'evidence_removed',
    actor_user_id: 'user-test',
    cycle_count_id: null,
    evidence_id: 'e2',
    maintenance_request_id: null,
    note: 'blurry',
    created_at: '2026-09-27T12:10:00Z',
    actor: { full_name: 'Test User', email: null },
  },
];

function service(
  opts: {
    evidence?: 'ok' | 'error';
    occurrence?: Record<string, unknown>;
    role?: 'staff' | 'viewer' | 'manager';
  } = {},
) {
  const stub = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': { data: opts.occurrence ?? occRow(), error: null },
    'exception_occurrences.select': { data: [opts.occurrence ?? occRow()], error: null },
    'exception_occurrence_events.select': { data: EVENTS, error: null },
    'exception_sync_state.select.maybeSingle': { data: null, error: null },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
    'exception_evidence.select':
      opts.evidence === 'error'
        ? { data: null, error: { message: 'evidence read failed' } }
        : { data: EV_ROWS, error: null },
  });
  const ctx = makeServiceContext(stub.client, { role: opts.role ?? 'staff' });
  return new ExceptionOccurrencesService(ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  signing.fail = false;
});

describe('ExceptionOccurrencesService.get: photo evidence', () => {
  it('carries the live photos with signed links, and what this reader may do', async () => {
    const d = await service().get(OCC);
    expect(d.evidence.status).toBe('ok');
    if (d.evidence.status !== 'ok') return;
    expect(d.evidence.photos.map((p) => p.id)).toEqual(['e1']);
    expect(d.evidence.photos[0]).toMatchObject({
      url: `https://signed/org/${OCC}/e1.jpg`,
      thumbUrl: `https://signed/org/${OCC}/e1-thumb.webp`,
      capturedAt: '2026-09-27T11:50:00Z',
      uploadedAt: '2026-09-27T12:00:00Z',
      canRemove: true,
    });
    expect(d.evidence).toMatchObject({ liveCount: 1, maxPhotos: 8, canAdd: true });
  });

  it("timeline evidence events carry the photo's two times, removed ones included", async () => {
    const d = await service().get(OCC);
    const byId = new Map(d.timeline.map((e) => [e.id, e]));
    expect(byId.get('v1')!.evidence).toBeNull();
    expect(byId.get('v2')!.evidence).toEqual({
      capturedAt: '2026-09-27T11:50:00Z',
      uploadedAt: '2026-09-27T12:00:00Z',
      removed: false,
    });
    expect(byId.get('v4')!.evidence).toEqual({
      capturedAt: null,
      uploadedAt: '2026-09-27T12:05:00Z',
      removed: true,
    });
    expect(byId.get('v4')!.note).toBe('blurry');
  });

  it('a failed photo read is "unavailable" (never an empty gallery), reported, and the detail still renders', async () => {
    const d = await service({ evidence: 'error' }).get(OCC);
    expect(d.evidence).toEqual({ status: 'unavailable' });
    expect(d.occurrence.id).toBe(OCC);
    expect(d.timeline).toHaveLength(4);
    // The timeline still names the photos; only their times are unknown.
    expect(d.timeline.find((e) => e.id === 'v2')!.evidence).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'exceptions.evidence_read' }),
    );
  });

  it('a signing failure is "unavailable" too, and reported', async () => {
    signing.fail = true;
    const d = await service().get(OCC);
    expect(d.evidence).toEqual({ status: 'unavailable' });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'exceptions.evidence_sign' }),
    );
  });

  it('a viewer sees the photos but may neither add nor remove', async () => {
    const d = await service({ role: 'viewer' }).get(OCC);
    if (d.evidence.status !== 'ok') throw new Error('unavailable');
    expect(d.evidence.canAdd).toBe(false);
    expect(d.evidence.photos.every((p) => !p.canRemove)).toBe(true);
  });

  it('a resolved occurrence keeps its photos visible, with nothing to add or remove', async () => {
    const d = await service({
      occurrence: occRow({ resolved_at: '2026-09-27T13:00:00Z', resolved_reason: 'cleared' }),
    }).get(OCC);
    if (d.evidence.status !== 'ok') throw new Error('unavailable');
    expect(d.evidence.photos).toHaveLength(1);
    expect(d.evidence.canAdd).toBe(false);
    expect(d.evidence.photos[0]!.canRemove).toBe(false);
  });
});
