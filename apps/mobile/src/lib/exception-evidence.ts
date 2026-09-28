import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  describeEvidenceEvent,
  exceptionEvidenceAddDisabledReason,
} from '@stockpilot/core';

import { api } from './api';
import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { checkPhotoCap } from './photo-cap';

/**
 * Photo evidence on an exception, on the phone (F1-4). The native twin of the
 * web photo panel, over the Bearer routes:
 *
 *   POST   /api/v1/exceptions/[id]/evidence               start an upload
 *   POST   /api/v1/exceptions/[id]/evidence/finalize      record it
 *   DELETE /api/v1/exceptions/[id]/evidence/[evidenceId]  remove (soft)
 *
 * and the `evidence` block of GET /api/v1/exceptions/[id].
 *
 * THE RULES THIS MODULE KEEPS:
 *
 *   1. ONLINE ONLY (owner decision F1 Q6). Nothing is queued for later: the
 *      add control is disabled offline with core's words, which say so.
 *   2. A failed or malformed photo read is `unavailable`, never "no photos"
 *      and never fewer photos (parseEvidenceBlock).
 *   3. NO PHANTOM PHOTO. A photo counts as added only when the server says it
 *      recorded it. A failed upload is a row that says it was not added, with
 *      a retry that is safe to press: when the bytes reached the server but
 *      its answer was lost, the retry records THAT upload again
 *      (exception-evidence-upload.ts runEvidenceAttempt's `resume`), and the
 *      server answers `already_recorded` if the first one landed, so a retry
 *      never adds the same photo twice.
 *   4. Every sentence the web also shows comes from core
 *      (exception-evidence.ts there). The words here are the phone's own
 *      states only (an upload in flight, an unconfirmed upload, offline
 *      removal).
 *
 * The server removes location and camera details from every photo when it
 * records it (core EXCEPTION_EVIDENCE_PRIVACY_COPY); the phone reads the
 * picker's EXIF only for the capture time (evidenceCapturedAt) and sends
 * nothing else from it.
 *
 * No native imports here (the upload itself is exception-evidence-upload.ts),
 * so exceptions-api.ts and the node tests can load this module.
 */

// ── Shapes (mirrors of the server's) ────────────────────────────────────────

export interface MobileEvidencePhoto {
  id: string;
  uploadedBy: { id: string | null; label: string };
  /** The DEVICE's clock when it was taken; null when the device did not say. */
  capturedAt: string | null;
  /** The SERVER's clock when it was recorded. */
  uploadedAt: string;
  note: string | null;
  contentType: string;
  byteSize: number;
  /** 1-hour signed link to the photo. */
  url: string;
  /** 1-hour signed link to its thumbnail, or null (show `url`). */
  thumbUrl: string | null;
  /** The server's hint that this reader may remove it (the database decides). */
  canRemove: boolean;
}

export type MobileEvidenceBlock =
  | {
      status: 'ok';
      /** Live photos, oldest first. */
      photos: MobileEvidencePhoto[];
      liveCount: number;
      maxPhotos: number;
      /** The server's hint that this reader may add one now. */
      canAdd: boolean;
    }
  | { status: 'unavailable' };

/** What a timeline event needs about the photo it names. */
export interface MobileEvidenceEventInfo {
  capturedAt: string | null;
  uploadedAt: string;
  removed: boolean;
}

export const EVIDENCE_UNAVAILABLE: MobileEvidenceBlock = { status: 'unavailable' };

/** Thrown when an evidence answer does not have the shape the phone needs. */
export class EvidenceResponseError extends Error {
  constructor() {
    super('The server sent an unexpected answer. Try again.');
    this.name = 'EvidenceResponseError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isLink(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

function parsePhoto(v: unknown): MobileEvidencePhoto | null {
  if (!isObj(v) || typeof v.id !== 'string' || !isLink(v.url) || typeof v.uploadedAt !== 'string') {
    return null;
  }
  const by = isObj(v.uploadedBy) && typeof v.uploadedBy.label === 'string'
    ? { id: strOrNull(v.uploadedBy.id), label: v.uploadedBy.label }
    : { id: null, label: 'Former member' };
  return {
    id: v.id,
    uploadedBy: by,
    capturedAt: strOrNull(v.capturedAt),
    uploadedAt: v.uploadedAt,
    note: strOrNull(v.note),
    contentType: typeof v.contentType === 'string' ? v.contentType : 'image/jpeg',
    byteSize: typeof v.byteSize === 'number' && Number.isFinite(v.byteSize) ? v.byteSize : 0,
    url: v.url,
    thumbUrl: isLink(v.thumbUrl) ? v.thumbUrl : null,
    // Anything but an explicit true is "no": the phone never offers a removal
    // the server did not say this reader may make.
    canRemove: v.canRemove === true,
  };
}

/**
 * The detail's `evidence` block. Anything but a well-formed `ok` block is
 * `unavailable`: a missing block (a server without photos), the server's own
 * `unavailable`, or ONE photo the phone cannot show. The last is the
 * important one: dropping that photo would show fewer photos than there are,
 * which is an error shown as an answer.
 */
export function parseEvidenceBlock(v: unknown): MobileEvidenceBlock {
  if (!isObj(v) || v.status !== 'ok' || !Array.isArray(v.photos)) return EVIDENCE_UNAVAILABLE;
  const photos: MobileEvidencePhoto[] = [];
  for (const p of v.photos) {
    const photo = parsePhoto(p);
    if (!photo) return EVIDENCE_UNAVAILABLE;
    photos.push(photo);
  }
  const live =
    typeof v.liveCount === 'number' && Number.isFinite(v.liveCount) ? Math.floor(v.liveCount) : 0;
  return {
    status: 'ok',
    photos,
    // Never fewer than the photos listed.
    liveCount: Math.max(live, photos.length),
    maxPhotos: EXCEPTION_EVIDENCE_MAX_PHOTOS,
    canAdd: v.canAdd === true,
  };
}

/** A timeline event's photo info, or null (another kind, or unreadable). */
export function parseEvidenceEventInfo(v: unknown): MobileEvidenceEventInfo | null {
  if (!isObj(v) || typeof v.uploadedAt !== 'string') return null;
  return { capturedAt: strOrNull(v.capturedAt), uploadedAt: v.uploadedAt, removed: v.removed === true };
}

// ── Requests ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finalize downloads and re-encodes up to 10 MB on the server. */
export const EVIDENCE_FINALIZE_TIMEOUT_MS = 45_000;

export interface EvidenceUploadTicket {
  path: string;
  signedUrl: string;
}

/** Start an upload: where to PUT the photo. */
export async function startEvidenceUpload(
  occurrenceId: string,
  fileExt: string,
): Promise<EvidenceUploadTicket> {
  if (!UUID.test(occurrenceId)) throw new EvidenceResponseError();
  const res = await api<unknown>(`/api/v1/exceptions/${occurrenceId}/evidence`, {
    method: 'POST',
    body: { fileExt },
  });
  if (!isObj(res) || typeof res.path !== 'string' || !isLink(res.signedUrl)) {
    throw new EvidenceResponseError();
  }
  return { path: res.path, signedUrl: res.signedUrl };
}

export interface RecordedEvidence {
  id: string;
  capturedAt: string | null;
  uploadedAt: string | null;
}

/** Record an uploaded photo. The server checks the bytes first. */
export async function finalizeEvidence(
  occurrenceId: string,
  input: {
    path: string;
    declaredMime: string;
    capturedAt: string | null;
    note: string | null;
  },
): Promise<RecordedEvidence> {
  if (!UUID.test(occurrenceId)) throw new EvidenceResponseError();
  const res = await api<unknown>(`/api/v1/exceptions/${occurrenceId}/evidence/finalize`, {
    method: 'POST',
    body: {
      path: input.path,
      declaredMime: input.declaredMime,
      capturedAt: input.capturedAt,
      note: input.note,
    },
    timeoutMs: EVIDENCE_FINALIZE_TIMEOUT_MS,
  });
  const ev = isObj(res) && isObj(res.evidence) ? res.evidence : null;
  if (!ev || typeof ev.id !== 'string') throw new EvidenceResponseError();
  return { id: ev.id, capturedAt: strOrNull(ev.capturedAt), uploadedAt: strOrNull(ev.uploadedAt) };
}

/** Remove a photo (soft: the server keeps the file and records who and why). */
export async function removeEvidence(
  occurrenceId: string,
  evidenceId: string,
  reason: string | null,
): Promise<{ id: string; removedAt: string }> {
  if (!UUID.test(occurrenceId) || !UUID.test(evidenceId)) throw new EvidenceResponseError();
  const res = await api<unknown>(`/api/v1/exceptions/${occurrenceId}/evidence/${evidenceId}`, {
    method: 'DELETE',
    body: reason ? { reason } : undefined,
  });
  const ev = isObj(res) && isObj(res.evidence) ? res.evidence : null;
  if (!ev || typeof ev.id !== 'string' || typeof ev.removedAt !== 'string') {
    throw new EvidenceResponseError();
  }
  return { id: ev.id, removedAt: ev.removedAt };
}

// ── One upload attempt ────────────────────────────────────────────────────

/** An upload whose bytes are on the server, to record again after a lost
 *  answer. */
export interface EvidenceResume {
  path: string;
  declaredMime: 'image/jpeg' | 'image/png' | 'image/webp';
}

// ── Reading an error (shared with exception-evidence-upload.ts) ────────────

export const EVIDENCE_NO_PERMISSION_COPY = 'You do not have permission to add photos to this exception.';
export const EVIDENCE_NOT_AVAILABLE_COPY = 'This exception is no longer available to you.';
export const EVIDENCE_TOO_MANY_COPY = 'Too many requests. Wait a moment and try again.';
export const EVIDENCE_SERVER_PROBLEM_COPY = 'The server had a problem. Try again in a moment.';

/** The HTTP status of an ApiError, or null (no answer at all). */
export function statusOf(e: unknown): number | null {
  return isObj(e) && typeof e.status === 'number' ? e.status : null;
}

/** The route's app-authored `details.reason`, or null. */
export function reasonOf(e: unknown): string | null {
  const details = isObj(e) ? e.details : undefined;
  return isObj(details) && typeof details.reason === 'string' ? details.reason : null;
}

/** The server's own sentence, when it sent one (a lone code is not one). */
export function sentenceOf(e: unknown): string | null {
  const m = e instanceof Error ? e.message : null;
  return m && !/^[a-z0-9_]+$/.test(m) ? m : null;
}

// ── The capture time ───────────────────────────────────────────────────────

/**
 * The instant EXIF says the photo was taken, or null. Only DateTimeOriginal
 * WITH OffsetTimeOriginal names an instant: a time without its offset could
 * be any of 26 instants, and the timeline would print a wrong one as fact.
 */
export function exifCaptureInstant(exif: Record<string, unknown> | null | undefined): string | null {
  if (!exif) return null;
  const dt = exif.DateTimeOriginal;
  const off = exif.OffsetTimeOriginal;
  if (typeof dt !== 'string' || typeof off !== 'string') return null;
  const d = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(dt.trim());
  const o = /^([+-])(\d{2}):?(\d{2})$/.exec(off.trim());
  if (!d || !o) return null;
  const [, y, mo, da, h, mi, s] = d;
  const month = Number(mo);
  const day = Number(da);
  if (Number(y) < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  if (Number(o[2]) > 14 || Number(o[3]) > 59) return null;
  const t = Date.parse(`${y}-${mo}-${da}T${h}:${mi}:${s}${o[1]}${o[2]}:${o[3]}`);
  if (!Number.isFinite(t)) return null;
  // A day the month does not have (Feb 31) rolls over in some engines:
  // refuse it rather than print another day.
  const local = new Date(t + (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60_000);
  if (local.getUTCDate() !== day || local.getUTCMonth() + 1 !== month) return null;
  return new Date(t).toISOString();
}

/**
 * When the photo was taken, by the DEVICE's clock (the copy says whose clock
 * it is): the EXIF capture instant when the picker gave one; otherwise, for a
 * photo just taken with the camera, the moment the camera handed it back;
 * otherwise (a library photo with no usable EXIF) null, which the timeline
 * words as "the device did not say". Never the moment a library photo was
 * picked: that is not when it was taken.
 */
export function evidenceCapturedAt(input: {
  source: 'camera' | 'library';
  exif?: Record<string, unknown> | null;
  pickedAt: Date;
}): string | null {
  const fromExif = exifCaptureInstant(input.exif ?? null);
  if (fromExif) return fromExif;
  return input.source === 'camera' ? input.pickedAt.toISOString() : null;
}

// ── The upload rows on screen ──────────────────────────────────────────────

/** One photo being added, as its row shows it. The server's list is the only
 *  place a photo counts as added; this row says what is happening to it. */
export interface EvidenceQueueEntry {
  key: string;
  /** The local file, for the row's preview. */
  uri: string;
  fileName?: string;
  capturedAt: string | null;
  note: string | null;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  message?: string;
  /** For an error row: what Retry does (null: Discard only). */
  retry: 'upload' | 'record' | null;
  /** The upload a 'record' retry records again. */
  resume: EvidenceResume | null;
  /** For a done row: the recorded photo, or null when the server said it
   *  was already recorded (an earlier attempt's answer was lost). */
  evidenceId: string | null;
  /** For a done row: its tick (evidenceTick), so the first read that started
   *  after it retires it even without an id. */
  doneAt: number | null;
}

let tick = 0;
/** A strictly increasing tick, for ordering a done upload against a read. */
export function evidenceTick(): number {
  tick += 1;
  return tick;
}

/**
 * The rows still to show. A done row is retired once a successful read can
 * show its photo: its id is in the list, or (no id) the read STARTED after
 * the row finished. Until then it stays, saying it was added, so a saved
 * photo never vanishes from the screen. Uploading and error rows always stay.
 */
export function visibleEvidenceQueue(
  entries: readonly EvidenceQueueEntry[],
  block: MobileEvidenceBlock,
  readTick: number,
): EvidenceQueueEntry[] {
  if (block.status !== 'ok') return [...entries];
  const ids = new Set(block.photos.map((p) => p.id));
  return entries.filter((e) => {
    if (e.status !== 'done') return true;
    if (e.evidenceId !== null) return !ids.has(e.evidenceId);
    return e.doneAt === null || readTick < e.doneAt;
  });
}

/** Photos added but not yet in the list, and photos on their way: both take
 *  a slot. Failed rows do not (nothing was recorded, or a retry decides). */
function queuedSlots(entries: readonly EvidenceQueueEntry[]): { done: number; uploading: number } {
  return {
    done: entries.filter((e) => e.status === 'done').length,
    uploading: entries.filter((e) => e.status === 'uploading').length,
  };
}

/** How many more photos may be picked now (the library's selection limit). */
export function evidenceRoomLeft(liveCount: number, visible: readonly EvidenceQueueEntry[]): number {
  const q = queuedSlots(visible);
  return Math.max(0, EXCEPTION_EVIDENCE_MAX_PHOTOS - liveCount - q.done - q.uploading);
}

/**
 * The cap for a new selection, through the shared checkPhotoCap arithmetic
 * (existing + queued + incoming > 8), in core's words. The server re-checks
 * at the mint, at finalize and in the database, under a lock.
 */
export function evidenceCapCheck(args: {
  liveCount: number;
  visible: readonly EvidenceQueueEntry[];
  incoming: number;
}): { ok: true } | { ok: false; message: string } {
  const q = queuedSlots(args.visible);
  const res = checkPhotoCap({
    existing: args.liveCount + q.done,
    pending: q.uploading,
    incoming: args.incoming,
    max: EXCEPTION_EVIDENCE_MAX_PHOTOS,
  });
  return res.ok ? res : { ok: false, message: EXCEPTION_EVIDENCE_CAP_COPY };
}

/**
 * The add control: whether it is offered at all, and why it is disabled.
 *   - Not offered on a resolved exception or to a reader who may not act
 *     (the reason is shown instead, as for Acknowledge).
 *   - Not offered while the photos could not be read: an unknown count is
 *     never read as room to spare.
 *   - Offered but DISABLED, with core's reason, while offline (nothing is
 *     queued) or at the cap (photos in flight count).
 */
export function evidenceAddControl(input: {
  block: MobileEvidenceBlock;
  resolved: boolean;
  canAct: boolean;
  online: boolean;
  visible: readonly EvidenceQueueEntry[];
}): { offered: boolean; reason: string | null } {
  const queued = queuedSlots(input.visible);
  const liveCount = input.block.status === 'ok' ? input.block.liveCount : 0;
  const reason = exceptionEvidenceAddDisabledReason({
    resolved: input.resolved,
    canAct: input.canAct,
    online: input.online,
    liveCount: liveCount + queued.done + queued.uploading,
  });
  const offered = !input.resolved && input.canAct && input.block.status === 'ok';
  return { offered, reason };
}

/** Why Retry on a failed row is disabled (offline: nothing is queued). */
export function evidenceRetryDisabledReason(online: boolean): string | null {
  return online ? null : EXCEPTION_EVIDENCE_OFFLINE_COPY;
}

/**
 * What a row says under its preview. A failed row never reads as added: "Not
 * added" when nothing was recorded, "Not confirmed" when the photo reached
 * the server and its answer was lost (Retry then records that upload).
 */
export function evidenceQueueRowCopy(
  entry: Pick<EvidenceQueueEntry, 'status' | 'progress' | 'message' | 'retry'>,
): string {
  if (entry.status === 'uploading') {
    const pct = Math.round(Math.min(1, Math.max(0, entry.progress)) * 100);
    return pct > 0 ? `Uploading ${pct}%` : 'Uploading';
  }
  if (entry.status === 'done') return EVIDENCE_ADDED_PENDING_COPY;
  const message = entry.message ?? CONNECTION_FAILURE_COPY;
  return entry.retry === 'record' ? `Not confirmed. ${message}` : `Not added. ${message}`;
}

/** A photo the server recorded that the list does not show yet. */
export const EVIDENCE_ADDED_PENDING_COPY = 'Added. It shows in the list once the list refreshes.';

// ── Notes and removal ─────────────────────────────────────────────────────

/** A photo's note or a removal's reason: over the limit is refused here with
 *  the server's words, before anything is sent. */
export function evidenceTextState(text: string): { length: number; tooLong: boolean } {
  const length = Array.from(text.trim()).length;
  return { length, tooLong: length > EXCEPTION_EVIDENCE_NOTE_MAX };
}

export const EVIDENCE_NOTE_TOO_LONG_COPY = `Notes can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`;
export const EVIDENCE_REASON_TOO_LONG_COPY = `A reason can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`;

/** Why Remove is disabled: removing needs a connection too. */
export const EVIDENCE_REMOVE_OFFLINE_COPY = 'You are offline. Removing a photo needs a connection.';

/** The sentence for a failed removal, keyed on status and reason. */
export function describeRemoveEvidenceError(e: unknown): string {
  const status = statusOf(e);
  const reason = reasonOf(e);
  if (status === 409 && reason === 'occurrence_resolved') return EXCEPTION_EVIDENCE_RESOLVED_COPY;
  if (status === 403) {
    return sentenceOf(e) ?? 'Only the person who added a photo, or a manager, can remove it.';
  }
  if (status === 404) return 'This photo is no longer available. Pull down to refresh.';
  if (status === 400 && reason === 'reason_too_long') return EVIDENCE_REASON_TOO_LONG_COPY;
  if (status === 429) return EVIDENCE_TOO_MANY_COPY;
  if (status !== null && status >= 500) return EVIDENCE_SERVER_PROBLEM_COPY;
  if (status === null) return CONNECTION_FAILURE_COPY;
  return sentenceOf(e) ?? 'The photo could not be removed.';
}

// ── Timeline ───────────────────────────────────────────────────────────────

/**
 * One evidence event's lines (core describeEvidenceEvent). Without the
 * photo's info (the photos could not be read), the headline and note only:
 * the times are left out rather than printed as "the device did not say".
 */
export function evidenceTimelineLines(event: {
  kind: 'evidence_added' | 'evidence_removed';
  actorLabel: string | null;
  note: string | null;
  evidence: MobileEvidenceEventInfo | null;
  timeZone: string | null;
}): { headline: string; detail: string | null; note: string | null } {
  const lines = describeEvidenceEvent({
    kind: event.kind,
    actorLabel: event.actorLabel,
    capturedAt: event.evidence?.capturedAt ?? null,
    uploadedAt: event.evidence?.uploadedAt ?? null,
    note: event.note,
    timeZone: event.timeZone,
  });
  return event.evidence || event.kind === 'evidence_removed' ? lines : { ...lines, detail: null };
}
