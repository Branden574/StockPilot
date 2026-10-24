import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import { GET as getPoChecks } from '../po/[id]/receiving-checks/route';
import { POST as startCheck } from '../receipts/[id]/receiving-check/route';
import { GET as getEditor, POST as publish } from '../receiving-checklist/route';
import { POST as retire } from '../receiving-checklist/retire/route';
import { GET as getRun, POST as saveRun } from './[id]/route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/receiving-checklist', () => ({ ReceivingChecklistService: vi.fn() }));

/**
 * The receiving checklist routes (F4-1), each a thin wrapper over
 * ReceivingChecklistService: 401 without a session (cookie or Bearer, both
 * through withApiContext), 400 for a bad id or body before the service runs,
 * and the service's refusals as 403 / 404 / 409 / 400 with the app-authored
 * details, never database text.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const svc = {
  getEditor: vi.fn(),
  publish: vi.fn(),
  retire: vi.fn(),
  checksForPo: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
};

const ctx = {
  organizationId: 'org-1',
  userId: 'u-1',
  role: 'manager' as const,
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>(),
  supabase: {} as never,
};

function req(url: string, body?: unknown, raw?: string) {
  return new Request(`https://test.local${url}`, {
    method: body === undefined && raw === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  vi.mocked(ReceivingChecklistService).mockImplementation(function () {
    return svc as unknown as ReceivingChecklistService;
  });
});

const publishBody = {
  title: 'Delivery checks',
  steps: [{ kind: 'check', label: 'Slip' }],
  expectedCurrentId: null,
  clientPublishId: ID,
};
const saveBody = {
  results: { s1: { value: 'pass' } },
  note: null,
  expectedRevision: 0,
  saveId: U2,
  complete: false,
};

const handlers: Array<[string, () => Promise<Response>]> = [
  ['GET editor', () => getEditor(req('/api/v1/receiving-checklist'))],
  ['POST publish', () => publish(req('/api/v1/receiving-checklist', publishBody))],
  ['POST retire', () => retire(req('/api/v1/receiving-checklist/retire', { versionId: ID }))],
  ['GET po checks', () => getPoChecks(req(`/api/v1/po/${ID}/receiving-checks`), params(ID))],
  ['POST start', () => startCheck(req(`/api/v1/receipts/${ID}/receiving-check`, {}), params(ID))],
  ['GET run', () => getRun(req(`/api/v1/receiving-checks/${ID}`), params(ID))],
  ['POST save', () => saveRun(req(`/api/v1/receiving-checks/${ID}`, saveBody), params(ID))],
];

describe('every route', () => {
  it.each(handlers)('%s: 401 without a session', async (_n, call) => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(handlers)("%s: the service's module refusal is a 403", async (_n, call) => {
    for (const fn of Object.values(svc))
      fn.mockRejectedValue(
        new ServiceError('module_disabled', 'Receiving is turned off for this organization.', {
          reason: 'module_disabled',
        }),
      );
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'module_disabled',
      message: 'Receiving is turned off for this organization.',
      details: { reason: 'module_disabled' },
    });
  });

  it.each(handlers)('%s: a permission refusal is a 403 with its reason', async (_n, call) => {
    for (const fn of Object.values(svc))
      fn.mockRejectedValue(new ServiceError('forbidden', 'No.', { reason: 'not_recorder' }));
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'not_recorder' });
  });

  it.each(handlers)(
    '%s: an internal error is a bare 500, reported, with no database text',
    async (_n, call) => {
      for (const fn of Object.values(svc))
        fn.mockRejectedValue(
          new ServiceError('internal_error', 'relation "checklist_runs" does not exist'),
        );
      const res = await call();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('checklist_runs');
      expect(body.details).toBeUndefined();
      expect(reportError).toHaveBeenCalled();
    },
  );
});

describe('ids and bodies are checked before the service runs', () => {
  it.each([
    ['GET po checks', () => getPoChecks(req('/api/v1/po/nope/receiving-checks'), params('nope'))],
    [
      'POST start',
      () => startCheck(req('/api/v1/receipts/nope/receiving-check', {}), params('nope')),
    ],
    ['GET run', () => getRun(req('/api/v1/receiving-checks/nope'), params('nope'))],
    ['POST save', () => saveRun(req('/api/v1/receiving-checks/nope', saveBody), params('nope'))],
  ])('%s: a bad id is a 400', async (_n, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it.each([
    [
      'publish without a client id',
      () =>
        publish(req('/api/v1/receiving-checklist', { ...publishBody, clientPublishId: undefined })),
    ],
    ['publish with bad json', () => publish(req('/api/v1/receiving-checklist', undefined, '{'))],
    ['retire without a version', () => retire(req('/api/v1/receiving-checklist/retire', {}))],
    [
      'save with a negative revision',
      () =>
        saveRun(
          req(`/api/v1/receiving-checks/${ID}`, { ...saveBody, expectedRevision: -1 }),
          params(ID),
        ),
    ],
    [
      'save without a save id',
      () =>
        saveRun(
          req(`/api/v1/receiving-checks/${ID}`, { ...saveBody, saveId: undefined }),
          params(ID),
        ),
    ],
    [
      'save with bad json',
      () => saveRun(req(`/api/v1/receiving-checks/${ID}`, undefined, 'nope'), params(ID)),
    ],
  ])('%s: 400', async (_n, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('answers', () => {
  it('GET editor answers the editor view', async () => {
    svc.getEditor.mockResolvedValue({ live: null, history: [], nextVersionNumber: 1 });
    const res = await getEditor(req('/api/v1/receiving-checklist'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ editor: { live: null, history: [], nextVersionNumber: 1 } });
  });

  it('POST publish passes the body through and answers the version; a stale editor is a 409', async () => {
    svc.publish.mockResolvedValue({ id: ID, versionNumber: 2 });
    const res = await publish(
      req('/api/v1/receiving-checklist', { ...publishBody, procedureId: U2 }),
    );
    expect(res.status).toBe(200);
    expect(svc.publish).toHaveBeenCalledWith({
      title: 'Delivery checks',
      steps: [{ kind: 'check', label: 'Slip' }],
      procedureId: U2,
      expectedCurrentId: null,
      clientPublishId: ID,
    });
    expect(await res.json()).toEqual({ version: { id: ID, versionNumber: 2 } });
    svc.publish.mockRejectedValue(
      new ServiceError('conflict', 'Someone published.', { reason: 'checklist_changed' }),
    );
    const stale = await publish(req('/api/v1/receiving-checklist', publishBody));
    expect(stale.status).toBe(409);
    expect((await stale.json()).details).toEqual({ reason: 'checklist_changed' });
  });

  it('POST publish: a refused step is a 400 naming it', async () => {
    svc.publish.mockRejectedValue(
      new ServiceError('validation_error', 'Step 3 needs a label.', {
        reason: 'checklist_invalid',
        invalid: 'label_required',
        field: 'steps',
        step: 3,
      }),
    );
    const res = await publish(req('/api/v1/receiving-checklist', publishBody));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'Step 3 needs a label.',
      details: { reason: 'checklist_invalid', invalid: 'label_required', field: 'steps', step: 3 },
    });
  });

  it("GET po checks: the service's answer, ok or not; a PO the caller cannot see is a 404", async () => {
    svc.checksForPo.mockResolvedValue({ ok: false });
    const res = await getPoChecks(req(`/api/v1/po/${ID}/receiving-checks`), params(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checks: { ok: false } });
    expect(svc.checksForPo).toHaveBeenCalledWith(ID);
    svc.checksForPo.mockRejectedValue(new ServiceError('not_found', 'Purchase order not found.'));
    expect((await getPoChecks(req(`/api/v1/po/${ID}/receiving-checks`), params(ID))).status).toBe(
      404,
    );
  });

  it('POST start answers the run; no checklist on is a 409 with its reason', async () => {
    svc.start.mockResolvedValue({ runId: U2, created: true, versionNumber: 1 });
    const res = await startCheck(req(`/api/v1/receipts/${ID}/receiving-check`, {}), params(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: U2, created: true, versionNumber: 1 });
    expect(svc.start).toHaveBeenCalledWith(ID);
    svc.start.mockRejectedValue(
      new ServiceError('conflict', 'There is no receiving checklist turned on.', {
        reason: 'no_checklist',
      }),
    );
    const off = await startCheck(req(`/api/v1/receipts/${ID}/receiving-check`, {}), params(ID));
    expect(off.status).toBe(409);
    expect((await off.json()).details).toEqual({ reason: 'no_checklist' });
  });

  it('GET run: not visible is a 404', async () => {
    svc.getRun.mockRejectedValue(new ServiceError('not_found', 'That checklist was not found.'));
    expect((await getRun(req(`/api/v1/receiving-checks/${ID}`), params(ID))).status).toBe(404);
  });

  it('POST save passes the body through; an incomplete completion is a 400 with the keys', async () => {
    svc.saveRun.mockResolvedValue({
      id: ID,
      status: 'in_progress',
      revision: 1,
      results: {},
      note: null,
      completedAt: null,
    });
    const ok = await saveRun(req(`/api/v1/receiving-checks/${ID}`, saveBody), params(ID));
    expect(ok.status).toBe(200);
    expect(svc.saveRun).toHaveBeenCalledWith({
      runId: ID,
      results: { s1: { value: 'pass' } },
      note: null,
      expectedRevision: 0,
      saveId: U2,
      complete: false,
    });
    svc.saveRun.mockRejectedValue(
      new ServiceError('validation_error', 'Answer every required step before completing: Slip.', {
        reason: 'checklist_incomplete',
        missing: ['s1'],
        failedWithoutNote: [],
        photoStepsWithoutPhoto: [],
      }),
    );
    const bad = await saveRun(
      req(`/api/v1/receiving-checks/${ID}`, { ...saveBody, complete: true }),
      params(ID),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).details).toEqual({
      reason: 'checklist_incomplete',
      missing: ['s1'],
      failedWithoutNote: [],
      photoStepsWithoutPhoto: [],
    });
  });

  it('POST save: someone saved first is a 409 the screen can tell apart', async () => {
    svc.saveRun.mockRejectedValue(
      new ServiceError('conflict', 'Someone else saved.', { reason: 'checklist_run_changed' }),
    );
    const res = await saveRun(req(`/api/v1/receiving-checks/${ID}`, saveBody), params(ID));
    expect(res.status).toBe(409);
    expect((await res.json()).details).toEqual({ reason: 'checklist_run_changed' });
  });
});
