import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The photo evidence routes (F1-4) run the REAL ExceptionEvidenceService over
 * stubbed clients, so every status below is the service's own answer through
 * the exceptions routes' one error shape. withApiContext is the one
 * cookie-or-Bearer resolver.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
const limiter = vi.hoisted(() => ({ allowed: true, calls: [] as unknown[][] }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => {
    limiter.calls.push(args);
    return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + 60_000 };
  }),
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
    assertWarehouseAccess: vi.fn(async (wh: string, op: string, ctx: { role: string }) => {
      if (op === 'write' && ctx.role === 'viewer') throw new ForbiddenError('viewer');
      if (wh !== 'wh-a') throw new ForbiddenError('no write');
    }),
  };
});
const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { withApiContext } from '@/lib/auth/api-context';

import { DELETE as REMOVE } from './[id]/evidence/[evidenceId]/route';
import { POST as FINALIZE } from './[id]/evidence/finalize/route';
import { POST as MINT } from './[id]/evidence/route';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const OCC = '11111111-1111-4111-8111-111111111111';
const FILE = '33333333-3333-4333-8333-333333333333';
const EVID = '44444444-4444-4444-8444-444444444444';
const PATH = `${ORG}/${OCC}/${FILE}.jpg`;

let jpeg: Buffer;
let png: Buffer;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#abc' } })
    .jpeg()
    .toBuffer();
  png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#abc' } })
    .png()
    .toBuffer();
});

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 3,
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

function ctxWith(
  opts: {
    role?: 'manager' | 'staff' | 'viewer';
    occurrence?: Record<string, unknown> | null;
    evidenceRow?: Record<string, unknown> | null;
    removeRpc?: { data: unknown; error: { message: string; code?: string; hint?: string } | null };
    object?: Buffer;
  } = {},
) {
  const user = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': {
      data: opts.occurrence === undefined ? occRow() : opts.occurrence,
      error: null,
    },
    'exception_evidence.select': { data: null, error: null, count: 0 },
    'exception_evidence.select.maybeSingle': {
      data:
        opts.evidenceRow === undefined
          ? { id: EVID, occurrence_id: OCC, uploaded_by: 'u-1', removed_at: null }
          : opts.evidenceRow,
      error: null,
    },
    'rpc:exception_evidence_remove': opts.removeRpc ?? {
      data: { id: EVID, removed_at: '2026-09-27T12:00:00Z' },
      error: null,
    },
  });
  const createSignedUploadUrl = vi.fn(async () => ({
    data: { signedUrl: 'https://mock/upload', token: 'tok' },
    error: null,
  }));
  user.client.storage.from = vi.fn(() => ({ createSignedUploadUrl }));
  const admin = makeSupabaseStub({
    'exception_evidence.select.maybeSingle': { data: null, error: null },
    'rpc:exception_evidence_record': {
      data: {
        id: EVID,
        content_type: 'image/jpeg',
        byte_size: 700,
        captured_at: null,
        created_at: '2026-09-27T12:00:00Z',
        removed_at: null,
      },
      error: null,
    },
  });
  const object = opts.object ?? jpeg;
  const storage = {
    download: vi.fn(async () => ({
      data: { arrayBuffer: async () => new Uint8Array(object).buffer },
      error: null,
    })),
    upload: vi.fn(async (p: string) => ({ data: { path: p }, error: null })),
    remove: vi.fn(async () => ({ data: null, error: null })),
  };
  admin.client.storage.from = vi.fn(() => storage);
  adminHolder.client = admin.client;
  const ctx = {
    organizationId: ORG,
    userId: 'u-1',
    role: opts.role ?? 'staff',
    supabase: user.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
  vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
  return { user, admin, storage, createSignedUploadUrl };
}

const bearer = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { authorization: 'Bearer token-1', ...(init.headers ?? {}) },
  }) as never;
const cookie = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { cookie: 'sb-x-auth-token=abc', ...(init.headers ?? {}) },
  }) as never;
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const params2 = (id: string, evidenceId: string) => ({
  params: Promise.resolve({ id, evidenceId }),
});
const U = `https://t.local/api/v1/exceptions/${OCC}/evidence`;

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
});

describe('POST /api/v1/exceptions/[id]/evidence (start an upload)', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await MINT(bearer(U, json({ fileExt: 'jpg' })), params(OCC))).status).toBe(401);
  });

  it('serves a Bearer caller and a cookie caller alike', async () => {
    for (const make of [bearer, cookie]) {
      const { createSignedUploadUrl } = ctxWith();
      const req = make(U, json({ fileExt: 'jpg' }));
      const res = await MINT(req, params(OCC));
      expect(res.status).toBe(200);
      expect(vi.mocked(withApiContext)).toHaveBeenLastCalledWith(req);
      const body = await res.json();
      expect(body).toMatchObject({
        signedUrl: 'https://mock/upload',
        token: 'tok',
        contentType: 'image/jpeg',
        maxBytes: 10485760,
      });
      expect(body.path).toMatch(new RegExp(`^${ORG}/${OCC}/[0-9a-f-]{36}\\.jpg$`));
      expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('400 for a bad id, bad JSON, or a missing extension', async () => {
    ctxWith();
    expect((await MINT(bearer(U, json({ fileExt: 'jpg' })), params('nope'))).status).toBe(400);
    ctxWith();
    expect((await MINT(bearer(U, { method: 'POST', body: '{' }), params(OCC))).status).toBe(400);
    ctxWith();
    expect((await MINT(bearer(U, json({})), params(OCC))).status).toBe(400);
    ctxWith();
    const heic = await MINT(bearer(U, json({ fileExt: 'heic' })), params(OCC));
    expect([heic.status, (await heic.json()).details]).toEqual([
      400,
      { reason: 'invalid_extension' },
    ]);
  });

  it('403 for a viewer, 404 when not visible, 409 when resolved', async () => {
    ctxWith({ role: 'viewer' });
    expect((await MINT(bearer(U, json({ fileExt: 'jpg' })), params(OCC))).status).toBe(403);
    ctxWith({ occurrence: null });
    expect((await MINT(bearer(U, json({ fileExt: 'jpg' })), params(OCC))).status).toBe(404);
    ctxWith({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
    });
    const res = await MINT(bearer(U, json({ fileExt: 'jpg' })), params(OCC));
    expect([res.status, (await res.json()).details]).toEqual([
      409,
      { reason: 'occurrence_resolved' },
    ]);
  });

  it('409 rate_limited when the upload limiter refuses', async () => {
    limiter.allowed = false;
    ctxWith();
    const res = await MINT(bearer(U, json({ fileExt: 'jpg' })), params(OCC));
    expect([res.status, (await res.json()).details]).toEqual([409, { reason: 'rate_limited' }]);
  });
});

describe('POST /api/v1/exceptions/[id]/evidence/finalize', () => {
  const F = `${U}/finalize`;

  it('201 with the recorded photo', async () => {
    const { admin } = ctxWith();
    const res = await FINALIZE(
      bearer(F, json({ path: PATH, declaredMime: 'image/jpeg', note: 'label' })),
      params(OCC),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).evidence).toMatchObject({ id: EVID, contentType: 'image/jpeg' });
    expect(admin.rpcCalls.map((c) => c.name)).toEqual(['exception_evidence_record']);
  });

  it('has its own per-person limit (30 a minute) and answers 429 with Retry-After', async () => {
    ctxWith();
    await FINALIZE(bearer(F, json({ path: PATH, declaredMime: 'image/jpeg' })), params(OCC));
    expect(limiter.calls[0]).toEqual(['exceptions-evidence-finalize:u-1', 30, 60_000]);
    limiter.allowed = false;
    ctxWith();
    const res = await FINALIZE(
      bearer(F, json({ path: PATH, declaredMime: 'image/jpeg' })),
      params(OCC),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('400 invalid_image for a PNG declared as JPEG, and the upload is deleted', async () => {
    const { storage } = ctxWith({ object: png });
    const res = await FINALIZE(
      bearer(F, json({ path: PATH, declaredMime: 'image/jpeg' })),
      params(OCC),
    );
    expect([res.status, (await res.json()).details]).toEqual([400, { reason: 'invalid_image' }]);
    expect(storage.remove).toHaveBeenCalled();
  });

  it('403 invalid_path for a path outside this occurrence, before storage is touched', async () => {
    const { storage } = ctxWith();
    const res = await FINALIZE(
      bearer(
        F,
        json({
          path: `${ORG}/22222222-2222-4222-8222-222222222222/${FILE}.jpg`,
          declaredMime: 'image/jpeg',
        }),
      ),
      params(OCC),
    );
    expect([res.status, (await res.json()).details]).toEqual([403, { reason: 'invalid_path' }]);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('400 for a body without the path or the type', async () => {
    ctxWith();
    expect((await FINALIZE(bearer(F, json({ path: PATH })), params(OCC))).status).toBe(400);
  });
});

describe('DELETE /api/v1/exceptions/[id]/evidence/[evidenceId]', () => {
  const D = `${U}/${EVID}`;
  const del = (body?: string) =>
    bearer(D, { method: 'DELETE', ...(body !== undefined ? { body } : {}) });

  it('200 with no body (no reason), and with a reason', async () => {
    const a = ctxWith();
    const res = await REMOVE(del(), params2(OCC, EVID));
    expect([res.status, (await res.json()).evidence]).toEqual([
      200,
      { id: EVID, removedAt: '2026-09-27T12:00:00Z' },
    ]);
    expect(a.user.rpcCalls).toEqual([
      { name: 'exception_evidence_remove', args: { p_id: EVID, p_reason: null } },
    ]);
    const b = ctxWith();
    await REMOVE(del(JSON.stringify({ reason: 'blurry' })), params2(OCC, EVID));
    expect(b.user.rpcCalls[0]!.args).toEqual({ p_id: EVID, p_reason: 'blurry' });
  });

  it('400 for bad ids or bad JSON', async () => {
    ctxWith();
    expect((await REMOVE(del(), params2(OCC, 'nope'))).status).toBe(400);
    ctxWith();
    expect((await REMOVE(del('{'), params2(OCC, EVID))).status).toBe(400);
  });

  it("403 for someone else's photo, 404 when not found, 409 when resolved", async () => {
    ctxWith({
      evidenceRow: { id: EVID, occurrence_id: OCC, uploaded_by: 'u-2', removed_at: null },
    });
    expect((await REMOVE(del(), params2(OCC, EVID))).status).toBe(403);
    ctxWith({ evidenceRow: null });
    expect((await REMOVE(del(), params2(OCC, EVID))).status).toBe(404);
    ctxWith({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
    });
    const res = await REMOVE(del(), params2(OCC, EVID));
    expect([res.status, (await res.json()).details]).toEqual([
      409,
      { reason: 'occurrence_resolved' },
    ]);
  });

  it("an internal error never sends the database's text", async () => {
    ctxWith({
      removeRpc: {
        data: null,
        error: { message: 'relation "exception_evidence" secret detail', code: 'XX000' },
      },
    });
    const res = await REMOVE(del(), params2(OCC, EVID));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret detail');
  });
});
