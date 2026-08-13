import { describe, expect, it, vi } from 'vitest';

import { MAINTENANCE_MAX_PHOTOS } from '@stockpilot/core';

import {
  PHOTO_UPLOAD_GENERIC_ERROR,
  REQUEST_PHOTOS_CLOSED_NOTICE,
  REQUEST_PHOTOS_EMPTY_CLOSED,
  REQUEST_PHOTOS_EMPTY_EDITABLE,
  photoPermissionDenial,
  photoUploadErrorMessage,
  reconcileRequestPhotoQueue,
  requestPhotoCapCheck,
  requestPhotoUploadOptions,
  resolutionPhotoUploadOptions,
  requestPhotosEditability,
  requestPhotosEmptyCopy,
  requestPhotosHeading,
  type MaintenancePhotoQueueEntry,
} from './maintenance-request-photos';
import { UploadError } from './maintenance-upload';

/**
 * Decision tests for the DETAIL screen's request-photo card
 * (app/maintenance/[id].tsx). The screen itself cannot be rendered here —
 * vitest.config.ts scopes `include` to `src/**` precisely because `app/`
 * screens import native modules at load — so the card's decisions live in
 * maintenance-request-photos.ts and are pinned behaviorally HERE.
 *
 * Deliberately NOT tested by asserting on the screen's own source text: a
 * test that greps `[id].tsx` for a symbol passes just as happily against a
 * branch that renders nothing at all. Every assertion below runs the real
 * exported function and checks the value it returns.
 */

// maintenance-request-photos.ts imports `checkPhotoCap` from
// ./maintenance-upload, whose module body imports expo-file-system/legacy and
// expo-image-manipulator at top level — neither loads under the node test
// environment. Only the transitive native imports are faked; `checkPhotoCap`
// itself stays REAL, because the cap arithmetic under test here is precisely
// the composition of it with the queue accounting below. Module ids match
// maintenance-upload.ts's own import specifiers exactly (the /legacy subpath
// is load-bearing — see that file's header).
vi.mock('expo-file-system/legacy', () => ({
  createUploadTask: vi.fn(),
  uploadAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(),
}));
vi.mock('./maintenance-api', () => ({ mintPhotoUpload: vi.fn(), finalizePhoto: vi.fn() }));
vi.mock('./image-resize', () => ({ resizeForUpload: vi.fn() }));

function entry(over: Partial<MaintenancePhotoQueueEntry> = {}): MaintenancePhotoQueueEntry {
  return { key: 'k', uri: 'file:///a.jpg', status: 'uploading', progress: 0, ...over };
}

describe('requestPhotosEditability', () => {
  it('lets an open request add photos, with no closed notice', () => {
    expect(
      requestPhotosEditability({ archivedAt: null, cancelledAt: null, resolvedAt: null }),
    ).toEqual({ canAdd: true, closedNotice: null });
  });

  // Each of the three timestamps closes a request on its own — this is the
  // web detail page's own gate (page.tsx: `closed = Boolean(detail.archivedAt
  // || detail.cancelledAt || detail.resolvedAt)`), and the server refuses the
  // mint for exactly the same three (assertParentOwnedAndOpen). Missing any
  // one of them would offer a camera button that can only ever fail.
  it.each([['archivedAt'], ['cancelledAt'], ['resolvedAt']] as const)(
    'refuses adds once %s is set, and says why',
    (field) => {
      const detail = { archivedAt: null, cancelledAt: null, resolvedAt: null, [field]: '2026-08-13T00:00:00Z' };
      expect(requestPhotosEditability(detail)).toEqual({
        canAdd: false,
        closedNotice: REQUEST_PHOTOS_CLOSED_NOTICE,
      });
    },
  );

  it('does not invent a permission rule of its own — an open request is addable regardless of who is looking', () => {
    // Web renders the panel for every viewer who can open the page and lets
    // the SERVER refuse (submit + requester-owned-or-manage, re-checked at
    // mint AND finalize). Growing a client-side role gate here would hide the
    // affordance from people the server would have allowed.
    const open = { archivedAt: null, cancelledAt: null, resolvedAt: null };
    expect(requestPhotosEditability(open).canAdd).toBe(true);
    expect(Object.keys(requestPhotosEditability(open))).toEqual(['canAdd', 'closedNotice']);
  });
});

describe('requestPhotosHeading', () => {
  it('counts against the shared cap constant, not a hand-typed number', () => {
    expect(requestPhotosHeading(2)).toBe(`PHOTOS · 2/${MAINTENANCE_MAX_PHOTOS}`);
    expect(requestPhotosHeading(0)).toBe(`PHOTOS · 0/${MAINTENANCE_MAX_PHOTOS}`);
  });
});

describe('requestPhotosEmptyCopy', () => {
  it('names both real sources when the card is empty and open', () => {
    expect(requestPhotosEmptyCopy({ photoCount: 0, queued: 0, canAdd: true })).toBe(
      REQUEST_PHOTOS_EMPTY_EDITABLE,
    );
  });

  it('says nothing was ever added when the card is empty and closed', () => {
    expect(requestPhotosEmptyCopy({ photoCount: 0, queued: 0, canAdd: false })).toBe(
      REQUEST_PHOTOS_EMPTY_CLOSED,
    );
  });

  it('drops the hint the moment there is something to show', () => {
    expect(requestPhotosEmptyCopy({ photoCount: 1, queued: 0, canAdd: true })).toBeNull();
    // Web hides its hint while an upload is in flight even though the grid is
    // still empty (`uploads.length === 0 ? hint : null`); a queued row IS the
    // something-to-show.
    expect(requestPhotosEmptyCopy({ photoCount: 0, queued: 1, canAdd: true })).toBeNull();
  });
});

describe('requestPhotoCapCheck', () => {
  it('allows a selection that exactly fills the cap', () => {
    expect(
      requestPhotoCapCheck({ serverPhotoCount: MAINTENANCE_MAX_PHOTOS - 1, entries: [], incoming: 1 }),
    ).toEqual({ ok: true });
  });

  it('refuses one past the cap, quoting the cap', () => {
    const res = requestPhotoCapCheck({
      serverPhotoCount: MAINTENANCE_MAX_PHOTOS,
      entries: [],
      incoming: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toBe(
      `A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`,
    );
  });

  it('counts in-flight uploads, so a rapid second selection cannot burst past the cap', () => {
    const entries = Array.from({ length: MAINTENANCE_MAX_PHOTOS - 1 }, (_, i) =>
      entry({ key: `p${i}`, status: 'uploading' }),
    );
    expect(requestPhotoCapCheck({ serverPhotoCount: 1, entries, incoming: 1 }).ok).toBe(false);
  });

  it('counts a finished row that the server list has not caught up to yet', () => {
    // The bytes ARE on the server; `serverPhotoCount` simply predates the
    // refresh. Not counting it here would mint photo #9.
    const entries = [entry({ key: 'a', status: 'done', attachmentId: 'att-a' })];
    expect(
      requestPhotoCapCheck({ serverPhotoCount: MAINTENANCE_MAX_PHOTOS - 1, entries, incoming: 1 }).ok,
    ).toBe(false);
  });

  it('does NOT count a failed row — a failure holds no slot', () => {
    // The mirror-image bug: counting error rows would refuse a legal photo
    // after a couple of retries burned through the budget.
    const entries = Array.from({ length: MAINTENANCE_MAX_PHOTOS }, (_, i) =>
      entry({ key: `e${i}`, status: 'error', message: 'nope' }),
    );
    expect(requestPhotoCapCheck({ serverPhotoCount: 0, entries, incoming: 1 })).toEqual({ ok: true });
  });
});

describe('reconcileRequestPhotoQueue', () => {
  it('retires a finished row only once the server list can actually show it', () => {
    const entries = [
      entry({ key: 'a', status: 'done', attachmentId: 'att-a' }),
      entry({ key: 'b', status: 'done', attachmentId: 'att-b' }),
    ];
    expect(reconcileRequestPhotoQueue(entries, ['att-a']).map((e) => e.key)).toEqual(['b']);
  });

  it('KEEPS a finished row the server list is missing — the only evidence those bytes were saved', () => {
    const entries = [entry({ key: 'a', status: 'done', attachmentId: 'att-a' })];
    expect(reconcileRequestPhotoQueue(entries, [])).toHaveLength(1);
  });

  it('keeps a finished row that never learned its own id', () => {
    const entries = [entry({ key: 'a', status: 'done' })];
    expect(reconcileRequestPhotoQueue(entries, ['att-a', 'att-b'])).toHaveLength(1);
  });

  it('never touches in-flight or failed rows, even when an id collides', () => {
    const entries = [
      entry({ key: 'a', status: 'uploading', attachmentId: 'att-a' }),
      entry({ key: 'b', status: 'error', attachmentId: 'att-b', message: 'nope' }),
    ];
    expect(reconcileRequestPhotoQueue(entries, ['att-a', 'att-b']).map((e) => e.key)).toEqual([
      'a',
      'b',
    ]);
  });

  it('is a no-op on an empty queue', () => {
    expect(reconcileRequestPhotoQueue([], ['att-a'])).toEqual([]);
  });
});

describe('photoPermissionDenial', () => {
  // The whole point of the flag: once the OS will not prompt again, telling
  // someone to "allow it in the prompt" sends them to a prompt that will
  // never appear. Both sources must draw the line — before this module the
  // library branch showed one flat sentence either way.
  it.each([['camera'], ['library']] as const)(
    'points %s at the prompt while the OS will still ask',
    (source) => {
      const { message } = photoPermissionDenial(source, true);
      expect(message).toMatch(/prompt/i);
      expect(message).not.toMatch(/settings/i);
    },
  );

  it.each([['camera'], ['library']] as const)(
    'points %s at Settings once the OS will not ask again',
    (source) => {
      const { message } = photoPermissionDenial(source, false);
      expect(message).toMatch(/settings/i);
      expect(message).not.toMatch(/prompt/i);
    },
  );

  it('titles the two sources distinctly', () => {
    expect(photoPermissionDenial('camera', true).title).toBe('Camera access needed');
    expect(photoPermissionDenial('library', true).title).toBe('Photo access needed');
  });
});

describe('photoUploadErrorMessage', () => {
  it('forwards the transport-specific reason instead of one generic sentence', () => {
    // A rate-limit says "wait"; a refusal says "different photo"; a dropped
    // PUT says "check your connection". Collapsing them would give the wrong
    // instruction two times out of three.
    expect(photoUploadErrorMessage(new UploadError('rate_limited', 'Too many uploads in the last hour.'))).toBe(
      'Too many uploads in the last hour.',
    );
    expect(photoUploadErrorMessage(new UploadError('rejected', 'That photo was refused by the server.'))).toBe(
      'That photo was refused by the server.',
    );
    expect(photoUploadErrorMessage(new Error('Network request failed'))).toBe(
      'Network request failed',
    );
  });

  it('falls back rather than rendering a blank failure row', () => {
    // The silent-failure shape this feature must never produce: a row that
    // visibly failed with no text saying why. The hand-rolled `e instanceof
    // Error ? e.message : fallback` chain forwards '' here.
    expect(photoUploadErrorMessage(new Error(''))).toBe(PHOTO_UPLOAD_GENERIC_ERROR);
    expect(photoUploadErrorMessage(new Error('   '))).toBe(PHOTO_UPLOAD_GENERIC_ERROR);
    expect(photoUploadErrorMessage('a bare string rejection')).toBe(PHOTO_UPLOAD_GENERIC_ERROR);
    expect(photoUploadErrorMessage(undefined)).toBe(PHOTO_UPLOAD_GENERIC_ERROR);
  });
});

/**
 * THE PIN THAT DID NOT EXIST.
 *
 * A verifier flipped the detail screen's request-photo upload from
 * `kind: 'requester'` to `'resolution'` and ran the whole mobile suite:
 * 65 files / 1345 tests, all green. It then deleted the entire camera +
 * library affordance and got the same all-green result. The two properties
 * the feature exists for were protected by nothing, because the kind lived as
 * a bare literal inside JSX this harness cannot render (vitest is environment
 * 'node', include ['src/**\/*.test.ts']).
 *
 * These assertions are deliberately about VALUES returned by a module the
 * harness can import, not about the screen's source text. A `toContain` grep
 * over the screen would not have caught the flip either: the repo already had
 * `expect(src).toContain("{ kind: 'resolution' }")`, and the mutant satisfied
 * it — after the flip the screen held two 'resolution' literals and zero
 * 'requester' ones, and that pin still passed.
 */
describe('photo upload options — the two queues cannot silently swap', () => {
  it('the request queue uploads as a requester photo, not close-out proof', () => {
    expect(requestPhotoUploadOptions()).toEqual({ kind: 'requester' });
  });

  it('the close-out queue uploads as resolution proof', () => {
    expect(resolutionPhotoUploadOptions()).toEqual({ kind: 'resolution' });
  });

  it('the two queues never resolve to the same kind', () => {
    // The whole point of the seam: if a refactor collapses them, this fails
    // rather than silently filing problem photos as proof.
    expect(requestPhotoUploadOptions().kind).not.toBe(resolutionPhotoUploadOptions().kind);
  });
});
