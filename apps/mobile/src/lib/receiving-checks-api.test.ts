import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY as C, VERIFICATION_SESSION_ENDED_COPY } from '@stockpilot/core';

import { editorAnswer, IDS, poChecksAnswer, runAnswer } from './__fixtures__/receiving-checks';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  checklistErrorReason,
  checklistIncompleteKeys,
  checklistInvalidKey,
  checklistInvalidStep,
  describeChecklistError,
  getChecklistEditor,
  getPoChecks,
  getReceivingRun,
  parseChecklistEditor,
  parsePoChecks,
  parseReceivingRun,
  parseSavedRun,
  parseStartedRun,
  publishChecklist,
  ReceivingChecksRequestError,
  ReceivingChecksResponseError,
  retireChecklist,
  saveReceivingRun,
  startReceivingCheck,
} from './receiving-checks-api';

const api = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api }));

/**
 * F4-1 on the phone: the receiving checklist routes, read strictly. A shape
 * this build does not expect is a failure, never an empty checklist; ids are
 * checked before any request; refusals read in core's words, and no answer at
 * all reads as the phone's one connection sentence.
 */

/** An error as api() throws it for a route's JSON refusal. */
function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { name: 'ApiError', status, details });
}

beforeEach(() => api.mockReset());

describe('reading the answers', () => {
  it("a PO's checklist status: the versions and the runs", () => {
    const res = parsePoChecks(poChecksAnswer());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(res.versions[0]?.steps).toHaveLength(4);
    expect(res.runs[0]).toMatchObject({
      id: IDS.runA,
      receiptId: IDS.rcptA,
      status: 'completed',
      completedByName: 'Pat Lee',
      results: { s1: { value: 'fail', note: 'Wrong slip' } },
    });
  });

  it("the server's own failure reads as ok false (said as didn't load), never as no runs", () => {
    expect(parsePoChecks({ checks: { ok: false } })).toEqual({ ok: false });
  });

  it.each([
    ['no checks', {}],
    ['ok missing', { checks: { versions: [], runs: [] } }],
    ['runs not a list', { checks: { ok: true, versions: [], runs: null } }],
    [
      'a run with an unknown status',
      {
        checks: {
          ok: true,
          versions: [],
          runs: [{ ...poChecksAnswer().checks.runs[0], status: 'done' }],
        },
      },
    ],
  ])('%s is an unexpected answer', (_l, res) => {
    expect(() => parsePoChecks(res)).toThrow(ReceivingChecksResponseError);
  });

  it('one run for its screen, with each "About" claim as sent', () => {
    const v = parseReceivingRun(runAnswer());
    expect(v.run).toMatchObject({ id: IDS.runB, revision: 3, status: 'in_progress' });
    expect(v.run.results).toEqual({ s1: { value: 'pass' }, s3: { value: 12 } });
    expect(v.version.procedure).toEqual({ id: IDS.proc, title: 'Receiving SOP' });
    expect(v.about.warehouse).toEqual({ kind: 'ok', value: 'Main' });
    expect(v.about.stockOwner).toEqual({ kind: 'ok', value: ['North Charter'] });
    expect(v.about.billTo).toEqual({ kind: 'unavailable' });
    expect(v.about.stillToCome).toEqual({ kind: 'ok', value: 2 });
    expect(v.canRecord).toBe(true);
    // Desk check F10(d): a warehouse that did not load arrives as such.
    const failed = runAnswer();
    (failed.run.about as Record<string, unknown>).warehouse = { kind: 'unavailable' };
    expect(parseReceivingRun(failed).about.warehouse).toEqual({ kind: 'unavailable' });
    expect(v.timeZone).toBe('America/Los_Angeles');
  });

  // Mutation caught: a reader that defaults a missing field (an empty
  // stock owner would read as "No stock owner set", a missing canRecord as
  // read only) instead of refusing the answer.
  it.each([
    [
      'canRecord missing',
      (r: ReturnType<typeof runAnswer>) => delete (r.run as Record<string, unknown>).canRecord,
    ],
    [
      'a claim of an unknown kind',
      (r: ReturnType<typeof runAnswer>) => {
        (r.run.about as Record<string, unknown>).stockOwner = { kind: 'none' };
      },
    ],
    [
      'the warehouse as a bare name (not a claim)',
      (r: ReturnType<typeof runAnswer>) => {
        (r.run.about as Record<string, unknown>).warehouse = 'Main';
      },
    ],
    [
      'a revision that is not a number',
      (r: ReturnType<typeof runAnswer>) => {
        (r.run.run as Record<string, unknown>).revision = '3';
      },
    ],
  ])('a run answer with %s is refused', (_l, spoil) => {
    const r = runAnswer();
    spoil(r);
    expect(() => parseReceivingRun(r)).toThrow(ReceivingChecksResponseError);
  });

  it('a save, a start, the editor', () => {
    expect(
      parseSavedRun({
        run: {
          id: IDS.runB,
          status: 'completed',
          revision: 4,
          results: { s1: { value: 'pass' } },
          note: null,
          completedAt: '2026-10-05T00:00:00Z',
        },
      }),
    ).toMatchObject({ status: 'completed', revision: 4 });
    expect(parseStartedRun({ runId: IDS.runB, created: false, versionNumber: 2 })).toEqual({
      runId: IDS.runB,
      created: false,
      versionNumber: 2,
    });
    expect(() => parseStartedRun({ runId: 'x', created: true, versionNumber: 1 })).toThrow(
      ReceivingChecksResponseError,
    );
    const e = parseChecklistEditor(editorAnswer());
    expect(e.live?.versionNumber).toBe(2);
    expect(e.history[0]?.retiredByName).toBe('Sam Ortiz');
    expect(e.gate.canPublishChecklist).toBe(true);
    expect(e.nextVersionNumber).toBe(3);
  });
});

describe('the requests', () => {
  it('reads and writes the routes the web serves, with the bodies it accepts', async () => {
    api.mockResolvedValueOnce(poChecksAnswer());
    await getPoChecks(IDS.po);
    expect(api).toHaveBeenLastCalledWith(`/api/v1/po/${IDS.po}/receiving-checks`);

    api.mockResolvedValueOnce({ runId: IDS.runB, created: true, versionNumber: 2 });
    await startReceivingCheck(IDS.rcptB);
    expect(api).toHaveBeenLastCalledWith(`/api/v1/receipts/${IDS.rcptB}/receiving-check`, {
      method: 'POST',
    });

    api.mockResolvedValueOnce(runAnswer());
    await getReceivingRun(IDS.runB);
    expect(api).toHaveBeenLastCalledWith(`/api/v1/receiving-checks/${IDS.runB}`);

    const body = {
      results: { s1: { value: 'pass' } },
      note: null,
      expectedRevision: 3,
      saveId: IDS.org,
      complete: false,
    };
    api.mockResolvedValueOnce({
      run: {
        id: IDS.runB,
        status: 'in_progress',
        revision: 4,
        results: {},
        note: null,
        completedAt: null,
      },
    });
    await saveReceivingRun(IDS.runB, body);
    expect(api).toHaveBeenLastCalledWith(`/api/v1/receiving-checks/${IDS.runB}`, {
      method: 'POST',
      body,
    });

    api.mockResolvedValueOnce(editorAnswer());
    await getChecklistEditor();
    expect(api).toHaveBeenLastCalledWith('/api/v1/receiving-checklist');

    const publish = {
      title: 'T',
      steps: [{ kind: 'check' as const, label: 'A', help: null, required: true }],
      procedureId: null,
      expectedCurrentId: IDS.v2,
      clientPublishId: IDS.org,
    };
    api.mockResolvedValueOnce({ version: { id: IDS.v1, versionNumber: 3 } });
    await expect(publishChecklist(publish)).resolves.toEqual({ id: IDS.v1, versionNumber: 3 });
    expect(api).toHaveBeenLastCalledWith('/api/v1/receiving-checklist', {
      method: 'POST',
      body: publish,
    });

    api.mockResolvedValueOnce({ retired: { id: IDS.v2, versionNumber: 2 } });
    await retireChecklist(IDS.v2);
    expect(api).toHaveBeenLastCalledWith('/api/v1/receiving-checklist/retire', {
      method: 'POST',
      body: { versionId: IDS.v2 },
    });
  });

  // Mutation caught: an id built into the path unchecked (a malformed link
  // asked the server for "/api/v1/receiving-checks/../me").
  it('a malformed id never reaches the server', async () => {
    await expect(getReceivingRun('../me')).rejects.toThrow(ReceivingChecksRequestError);
    await expect(startReceivingCheck('nope')).rejects.toThrow(ReceivingChecksRequestError);
    await expect(getPoChecks('')).rejects.toThrow(ReceivingChecksRequestError);
    await expect(retireChecklist('x')).rejects.toThrow(ReceivingChecksRequestError);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('refusals in words', () => {
  it('no answer at all is the one connection sentence, never the network layer text', () => {
    const ios = new TypeError(
      'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
    );
    expect(describeChecklistError(ios, 'x')).toBe(CONNECTION_FAILURE_COPY);
    expect(describeChecklistError(new Error(REQUEST_TIMED_OUT_COPY), 'x')).toBe(
      REQUEST_TIMED_OUT_COPY,
    );
    expect(describeChecklistError(new ReceivingChecksResponseError(), 'x')).toBe(
      'The server sent an unexpected answer.',
    );
  });

  it('each reason the routes send reads in core words', () => {
    const cases: [number, string, string][] = [
      [403, 'module_disabled', C.moduleDisabled],
      [403, 'not_recorder', C.notRecorder],
      [403, 'not_publisher', C.notPublisher],
      [409, 'checklist_changed', C.publishChanged],
      [409, 'no_checklist', C.noChecklist],
      [409, 'receipt_not_checkable', C.receiptNotCheckable],
      [409, 'checklist_run_changed', C.runChanged],
      [409, 'busy', C.busy],
    ];
    for (const [status, reason, words] of cases) {
      expect(describeChecklistError(apiError(status, 'conflict', { reason }), 'x')).toBe(words);
    }
  });

  it('a sentence that names steps or a person is shown as sent; a bare code never is', () => {
    expect(
      describeChecklistError(
        apiError(
          409,
          "This checklist was completed by Sam Ortiz. Completed checklists can't be changed.",
          {
            reason: 'checklist_run_completed',
          },
        ),
        'x',
      ),
    ).toBe("This checklist was completed by Sam Ortiz. Completed checklists can't be changed.");
    expect(
      describeChecklistError(apiError(409, 'conflict', { reason: 'checklist_run_completed' }), 'x'),
    ).toBe(C.runCompleted);
    expect(
      describeChecklistError(
        apiError(400, 'Answer every required step before completing: Boxes.', {
          reason: 'checklist_incomplete',
        }),
        'x',
      ),
    ).toBe('Answer every required step before completing: Boxes.');
    expect(describeChecklistError(apiError(400, 'validation_error'), 'Fallback.')).toBe(
      'Fallback.',
    );
  });

  it('a session that ended, too many requests, and a server problem', () => {
    expect(describeChecklistError(apiError(401, 'unauthenticated'), 'x')).toBe(
      VERIFICATION_SESSION_ENDED_COPY,
    );
    expect(describeChecklistError(apiError(429, 'rate_limited'), 'x')).toMatch(
      /^Too many requests/,
    );
    expect(describeChecklistError(apiError(500, 'internal_error'), 'x')).toMatch(
      /^The server had a problem/,
    );
  });

  it('the details a screen marks steps with', () => {
    const incomplete = apiError(400, 'x', {
      reason: 'checklist_incomplete',
      missing: ['s1', 3],
      failedWithoutNote: ['s2'],
    });
    expect(checklistErrorReason(incomplete)).toBe('checklist_incomplete');
    expect(checklistIncompleteKeys(incomplete)).toEqual({
      missing: ['s1'],
      failedWithoutNote: ['s2'],
    });
    expect(checklistIncompleteKeys(apiError(409, 'x', { reason: 'busy' }))).toEqual({
      missing: [],
      failedWithoutNote: [],
    });
    const invalid = apiError(400, 'x', { reason: 'checklist_invalid', key: 's3', step: 2 });
    expect(checklistInvalidKey(invalid)).toBe('s3');
    expect(checklistInvalidStep(invalid)).toBe(2);
    expect(checklistErrorReason(new Error('x'))).toBeNull();
  });
});
