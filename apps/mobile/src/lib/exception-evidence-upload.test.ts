import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UNCONFIRMED_COPY,
  EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import {
  asEvidenceFailure,
  EVIDENCE_PUT_TIMEOUT_MS,
  EVIDENCE_UNCONFIRMED_COPY,
  EvidenceUploadFailure,
  runEvidenceAttempt,
  type EvidenceAttemptInput,
} from './exception-evidence-upload';
import { PHOTO_PUT_FAILED_COPY } from './signed-photo-upload';

/**
 * One photo attempt on an exception (F1-4): what each failure means for the
 * row (its words, and whether and how Retry is safe), and the retry that
 * records the SAME upload after a lost answer instead of sending a second
 * copy. Each block names the wrong code it catches.
 */

const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

const imageResizeMock = vi.hoisted(() => ({ resizeForUpload: vi.fn() }));
vi.mock('./image-resize', () => imageResizeMock);

const fsMock = vi.hoisted(() => ({
  createUploadTask: vi.fn(),
  uploadAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('expo-file-system/legacy', () => fsMock);

const manipulatorMock = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-image-manipulator', () => manipulatorMock);

const OCC = '11111111-1111-4111-8111-111111111111';
const EV = '33333333-3333-4333-8333-333333333333';
const PATH = `org-1/${OCC}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
const NEW_PATH = `org-1/${OCC}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`;

function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

type Route = 'mint' | 'finalize';
/** Answers per route, in order; a thrown value is an Error instance. */
let answers: Record<Route, unknown[]>;
let calls: { route: Route; body: unknown }[];

function routeOf(path: string): Route {
  return path.endsWith('/evidence/finalize') ? 'finalize' : 'mint';
}

function input(o: Partial<EvidenceAttemptInput> = {}): EvidenceAttemptInput {
  return {
    occurrenceId: OCC,
    asset: { uri: 'file:///camera.jpg', fileName: 'IMG_1.JPG' },
    capturedAt: '2026-09-27T17:02:00.000Z',
    note: 'Shelf 3',
    resume: null,
    onProgress: () => {},
    ...o,
  };
}

function putAnswers(status: number | Error) {
  fsMock.createUploadTask.mockImplementation(() => ({
    uploadAsync: async () => {
      if (status instanceof Error) throw status;
      return { status, headers: {}, mimeType: null, body: '' };
    },
  }));
}

async function failureOf(p: Promise<unknown>): Promise<EvidenceUploadFailure> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EvidenceUploadFailure);
  return e as EvidenceUploadFailure;
}

beforeEach(() => {
  answers = {
    mint: [{ path: PATH, signedUrl: 'https://s/put', token: 't', contentType: 'image/jpeg' }],
    finalize: [{ evidence: { id: EV, capturedAt: null, uploadedAt: 'u' } }],
  };
  calls = [];
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: unknown, opts: unknown) => {
    const route = routeOf(String(path));
    calls.push({ route, body: (opts as { body?: unknown }).body });
    const next = answers[route].length > 1 ? answers[route].shift() : answers[route][0];
    if (next instanceof Error) throw next;
    return next;
  });
  imageResizeMock.resizeForUpload.mockReset();
  imageResizeMock.resizeForUpload.mockResolvedValue({ uri: 'file:///resized.jpg', ext: 'jpg' });
  manipulatorMock.manipulateAsync.mockReset();
  manipulatorMock.manipulateAsync.mockResolvedValue({ uri: 'file:///converted.jpg' });
  fsMock.uploadAsync.mockReset();
  fsMock.createUploadTask.mockReset();
  putAnswers(200);
});

describe('a photo that goes through', () => {
  it('mints for the resized extension, PUTs the bytes, and records them with the device time and note', async () => {
    await expect(runEvidenceAttempt(input())).resolves.toEqual({ evidenceId: EV });
    expect(calls.map((c) => c.route)).toEqual(['mint', 'finalize']);
    expect(calls[0]!.body).toEqual({ fileExt: 'jpg' });
    expect(fsMock.createUploadTask).toHaveBeenCalledWith(
      'https://s/put',
      'file:///resized.jpg',
      expect.objectContaining({ httpMethod: 'PUT', headers: { 'Content-Type': 'image/jpeg' } }),
      expect.any(Function),
    );
    expect(calls[1]!.body).toEqual({
      path: PATH,
      declaredMime: 'image/jpeg',
      capturedAt: '2026-09-27T17:02:00.000Z',
      note: 'Shelf 3',
    });
  });

  // The server makes the thumbnail from the cleaned photo. Mutation caught:
  // passing a thumbUploadUrl (a client thumbnail could show another picture).
  it('makes and sends no thumbnail of its own', async () => {
    await runEvidenceAttempt(input());
    expect(manipulatorMock.manipulateAsync).not.toHaveBeenCalled();
    expect(fsMock.uploadAsync).not.toHaveBeenCalled();
  });

  it('a small GIF is converted to JPEG before the mint (the bucket takes JPEG, PNG and WEBP)', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValueOnce({ uri: 'file:///a.gif', ext: 'gif' });
    await runEvidenceAttempt(input());
    expect(calls[0]!.body).toEqual({ fileExt: 'jpg' });
  });

  it('reports the upload point once the bytes are on the server', async () => {
    const onUploaded = vi.fn();
    await runEvidenceAttempt(input({ onUploaded }));
    expect(onUploaded).toHaveBeenCalledWith({ path: PATH, declaredMime: 'image/jpeg' });
  });
});

describe('before the bytes reach the server: retry sends the photo again', () => {
  it('a failed PUT (non-2xx) or a dropped one (rejects): "upload" retry, never finalize', async () => {
    putAnswers(500);
    let f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry, f.resume]).toEqual([PHOTO_PUT_FAILED_COPY, 'upload', null]);
    putAnswers(new Error('The Internet connection appears to be offline.'));
    f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([PHOTO_PUT_FAILED_COPY, 'upload']);
    expect(calls.filter((c) => c.route === 'finalize')).toHaveLength(0);
  });

  // Review finding 2026-09-27. Mutations caught: the default (BACKGROUND)
  // session, where an interrupted upload waits for days and finishes on its
  // own later; and no time limit, where the row said "Uploading" with no way
  // out.
  it('the PUT runs in a FOREGROUND session with a time limit; a stalled one is cancelled: "upload" retry, never finalize', async () => {
    await runEvidenceAttempt(input());
    expect(fsMock.createUploadTask.mock.calls[0]![2]).toMatchObject({
      sessionType: fsMock.FileSystemSessionType.FOREGROUND,
    });
    expect(EVIDENCE_PUT_TIMEOUT_MS).toBe(90_000);

    vi.useFakeTimers();
    try {
      const cancelAsync = vi.fn(async () => {});
      fsMock.createUploadTask.mockImplementation(() => ({
        uploadAsync: () => new Promise(() => {}),
        cancelAsync,
      }));
      calls = [];
      const settled = failureOf(runEvidenceAttempt(input()));
      await vi.advanceTimersByTimeAsync(EVIDENCE_PUT_TIMEOUT_MS);
      const f = await settled;
      expect([f.message, f.retry, f.resume]).toEqual([PHOTO_PUT_FAILED_COPY, 'upload', null]);
      expect(cancelAsync).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => c.route === 'finalize')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the phone's sentences for a lost answer and the hourly limit are core's", async () => {
    expect(EVIDENCE_UNCONFIRMED_COPY).toBe(EXCEPTION_EVIDENCE_UNCONFIRMED_COPY);
    answers.mint = [apiError(409, 'rate_limited', { reason: 'rate_limited' })];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY, 'upload']);
  });

  it('no answer to the mint (offline): the connection words, "upload" retry', async () => {
    answers.mint = [new TypeError('Network request failed')];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([CONNECTION_FAILURE_COPY, 'upload']);
  });

  it('the resize itself failing says so (not a network problem)', async () => {
    imageResizeMock.resizeForUpload.mockRejectedValueOnce(new Error('decode failed'));
    const f = await failureOf(runEvidenceAttempt(input()));
    expect(f.message).toMatch(/could not be prepared/);
    expect(calls).toHaveLength(0);
  });

  it('the hourly limit: the server\'s words, and retry later', async () => {
    answers.mint = [
      apiError(409, 'Too many photo uploads in the last hour. Please try again later.', { reason: 'rate_limited' }),
    ];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual(['Too many photo uploads in the last hour. Please try again later.', 'upload']);
  });

  // Mutation caught: treating every mint 409 as a rate limit (the maintenance
  // mapping), which offered a Retry that can never work.
  it('refusals a retry cannot change: the cap, resolved, no permission, not visible', async () => {
    answers.mint = [apiError(409, 'x', { reason: 'evidence_limit_reached' })];
    let f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_CAP_COPY, null]);
    answers.mint = [apiError(409, 'x', { reason: 'occurrence_resolved' })];
    f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_RESOLVED_COPY, null]);
    answers.mint = [apiError(403, 'forbidden')];
    f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual(['You do not have permission to add photos to this exception.', null]);
    answers.mint = [apiError(404, 'Exception not found.')];
    f = await failureOf(runEvidenceAttempt(input()));
    expect(f.retry).toBeNull();
  });
});

describe('after the bytes reached the server', () => {
  // Mutation caught: an "upload" retry here, which would record the same
  // photo twice when the first one had landed.
  it('no answer from finalize: "Not confirmed", and the retry RECORDS THAT UPLOAD', async () => {
    answers.finalize = [new Error('Request timed out. Check your connection and try again.')];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry, f.resume]).toEqual([
      EVIDENCE_UNCONFIRMED_COPY,
      'record',
      { path: PATH, declaredMime: 'image/jpeg' },
    ]);
  });

  it('a server fault or the per-person limit: record that upload again', async () => {
    answers.finalize = [apiError(500, 'Something went wrong.')];
    let f = await failureOf(runEvidenceAttempt(input()));
    expect([f.retry, f.resume?.path]).toEqual(['record', PATH]);
    answers.finalize = [apiError(429, 'Too many requests.')];
    f = await failureOf(runEvidenceAttempt(input()));
    expect([f.retry, f.resume?.path]).toEqual(['record', PATH]);
  });

  it('the file was refused (not the image it claims): core\'s words, no retry', async () => {
    answers.finalize = [apiError(400, EXCEPTION_EVIDENCE_REJECTED_COPY, { reason: 'invalid_image' })];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_REJECTED_COPY, null]);
  });

  it('busy: nothing recorded and the upload removed, so the retry sends the photo again', async () => {
    answers.finalize = [
      apiError(409, 'This exception is busy. Please add the photo again.', { reason: 'busy', retryable: true }),
    ];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.retry, f.resume]).toEqual(['upload', null]);
  });

  it('resolved or at the cap by the time it is recorded: no retry', async () => {
    answers.finalize = [apiError(409, 'x', { reason: 'evidence_limit_reached' })];
    const f = await failureOf(runEvidenceAttempt(input()));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_CAP_COPY, null]);
  });

  it('"already recorded" is success, not a failure', async () => {
    answers.finalize = [apiError(409, 'This photo was already added.', { reason: 'already_recorded' })];
    await expect(runEvidenceAttempt(input())).resolves.toEqual({ evidenceId: null });
  });
});

describe('the "record" retry (resume)', () => {
  const resume = { path: PATH, declaredMime: 'image/jpeg' as const };

  // Mutation caught: ignoring `resume` (a fresh upload, a second copy).
  it('records the earlier upload without minting or uploading again', async () => {
    await expect(runEvidenceAttempt(input({ resume }))).resolves.toEqual({ evidenceId: EV });
    expect(calls.map((c) => c.route)).toEqual(['finalize']);
    expect(calls[0]!.body).toEqual({
      path: PATH,
      declaredMime: 'image/jpeg',
      capturedAt: '2026-09-27T17:02:00.000Z',
      note: 'Shelf 3',
    });
    expect(fsMock.createUploadTask).not.toHaveBeenCalled();
  });

  it('the first attempt had landed ("already recorded"): done, nothing sent again', async () => {
    answers.finalize = [apiError(409, 'This photo was already added.', { reason: 'already_recorded' })];
    await expect(runEvidenceAttempt(input({ resume }))).resolves.toEqual({ evidenceId: null });
    expect(calls.map((c) => c.route)).toEqual(['finalize']);
  });

  it('the earlier upload is gone (the server removed it): the photo is sent again, once', async () => {
    answers.mint = [{ path: NEW_PATH, signedUrl: 'https://s/put2' }];
    answers.finalize = [
      apiError(400, EXCEPTION_EVIDENCE_REJECTED_COPY, { reason: 'invalid_image' }),
      { evidence: { id: EV } },
    ];
    await expect(runEvidenceAttempt(input({ resume }))).resolves.toEqual({ evidenceId: EV });
    expect(calls.map((c) => c.route)).toEqual(['finalize', 'mint', 'finalize']);
    expect((calls[2]!.body as { path: string }).path).toBe(NEW_PATH);
  });

  it('still no answer: the same resume point, "record" again', async () => {
    answers.finalize = [new TypeError('Network request failed')];
    const f = await failureOf(runEvidenceAttempt(input({ resume })));
    expect([f.retry, f.resume]).toEqual(['record', resume]);
    expect(calls.map((c) => c.route)).toEqual(['finalize']);
  });

  it('refused on resume (resolved meanwhile): no retry', async () => {
    answers.finalize = [apiError(409, 'x', { reason: 'occurrence_resolved' })];
    const f = await failureOf(runEvidenceAttempt(input({ resume })));
    expect([f.message, f.retry]).toEqual([EXCEPTION_EVIDENCE_RESOLVED_COPY, null]);
  });
});

it('asEvidenceFailure keeps a failure and words anything else as a connection failure', () => {
  const f = new EvidenceUploadFailure('x', null, null);
  expect(asEvidenceFailure(f)).toBe(f);
  const other = asEvidenceFailure(new Error('boom'));
  expect([other.message, other.retry]).toEqual([CONNECTION_FAILURE_COPY, 'upload']);
});
