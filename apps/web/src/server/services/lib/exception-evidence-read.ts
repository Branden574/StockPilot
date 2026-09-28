import 'server-only';

import {
  canRemoveExceptionEvidence,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  isManagerOrAbove,
} from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';

import { ServiceError, type ServiceContext } from '../context';

import { personFor, type OccurrencePerson, type ProfileEmbed } from './occurrence-person';
import { fetchAllRows } from './paginate';

/**
 * READING photo evidence (F1-4, migration 0375): the rows, through the
 * reader's own client (exception_evidence RLS: visible where the occurrence
 * is), and 1-hour signed links for the live ones, minted with the service role
 * AFTER that read (the bucket has no SELECT policy; signing a path is
 * org-agnostic, so the RLS read is the authorization).
 *
 * Used by the occurrence read (GET /api/v1/exceptions/[id] and the web
 * detail) and by ExceptionEvidenceService. It has no dependency on either
 * service, so neither imports the other through it.
 */

export const EXCEPTION_EVIDENCE_BUCKET = 'exception-evidence';

/** In-app view links live one hour, like maintenance photos: evidence is
 *  looked at on one screen and must not outlive a session (never emailed,
 *  never cached for days). */
export const EVIDENCE_VIEW_URL_TTL_SEC = 60 * 60;

/** Paths per createSignedUrls call: storage-api refuses more than 1000 in one
 *  body (400 for the whole call). An occurrence holds at most 16 live paths
 *  today; the chunking keeps any future caller that signs across occurrences
 *  inside the limit. */
export const SIGN_PATHS_PER_CALL = 1000;

/** Rows read for one occurrence, removed ones included (a backstop: 8 live,
 *  and removals accumulate one at a time). */
const EVIDENCE_READ_CAP = 1000;

export const EVIDENCE_SELECT =
  'id, uploaded_by, storage_path, thumbnail_path, content_type, byte_size, captured_at, note, created_at, removed_at, removed_by, uploader:user_profiles!exception_evidence_uploaded_by_fkey(full_name, email)';

export type EvidenceRow = {
  id: string;
  uploaded_by: string | null;
  storage_path: string;
  thumbnail_path: string | null;
  content_type: string;
  byte_size: number | string;
  captured_at: string | null;
  note: string | null;
  created_at: string;
  removed_at: string | null;
  removed_by: string | null;
  uploader?: ProfileEmbed;
};

/** One live photo as a reader sees it. */
export interface ExceptionEvidencePhoto {
  id: string;
  uploadedBy: OccurrencePerson;
  /** The DEVICE's clock when taken, as the client reported it; null when it
   *  did not say. */
  capturedAt: string | null;
  /** The SERVER's clock when it was recorded. */
  uploadedAt: string;
  note: string | null;
  contentType: string;
  byteSize: number;
  /** 1-hour signed link to the photo. */
  url: string;
  /** 1-hour signed link to its 400 px thumbnail, or null (show `url`). */
  thumbUrl: string | null;
  /** Whether Remove is offered to this reader (the database re-checks). */
  canRemove: boolean;
}

/**
 * The photos on one occurrence. `unavailable` when they could not be read or
 * signed: a surface says so and NEVER shows "no photos" for it (an error is
 * not an empty answer).
 */
export type ExceptionEvidenceBlock =
  | {
      status: 'ok';
      /** Live photos, oldest first. Removed photos appear in the timeline
       *  only; their files are kept but not served. */
      photos: ExceptionEvidencePhoto[];
      liveCount: number;
      maxPhotos: number;
      /** Whether this reader may add a photo now (open, the act gate, under
       *  the cap). A hint; the server and the database decide. */
      canAdd: boolean;
    }
  | { status: 'unavailable' };

/** What the timeline needs about each photo an event names, removed ones
 *  included. */
export interface EvidenceEventInfo {
  capturedAt: string | null;
  uploadedAt: string;
  removed: boolean;
}

/** Every photo row on the occurrence, removed ones included, oldest first.
 *  THROWS on a failed read (the caller turns it into `unavailable`). */
export async function readEvidenceRows(
  ctx: ServiceContext,
  occurrenceId: string,
): Promise<EvidenceRow[]> {
  const rows = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      ctx.supabase
        .from('exception_evidence')
        .select(EVIDENCE_SELECT)
        .eq('organization_id', ctx.organizationId)
        .eq('occurrence_id', occurrenceId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { cap: EVIDENCE_READ_CAP },
  );
  return rows as unknown as EvidenceRow[];
}

/**
 * Signs paths in calls of at most SIGN_PATHS_PER_CALL, one call at a time.
 * Returns path -> signed URL, or null for a path the storage answered with an
 * error. THROWS when a whole call fails (nothing in it was signed).
 */
export async function signEvidencePaths(
  paths: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const store = createAdminClient().storage.from(EXCEPTION_EVIDENCE_BUCKET);
  for (let i = 0; i < paths.length; i += SIGN_PATHS_PER_CALL) {
    const chunk = paths.slice(i, i + SIGN_PATHS_PER_CALL);
    const { data, error } = await store.createSignedUrls(chunk, EVIDENCE_VIEW_URL_TTL_SEC);
    if (error || !data) throw new ServiceError('internal_error', 'Could not sign photo links.');
    for (const s of data) {
      if (s.path) out.set(s.path, !s.error && s.signedUrl ? s.signedUrl : null);
    }
  }
  return out;
}

/**
 * The block for one occurrence from its rows: signs the live photos and says
 * what this reader may do. `occurrence.canAct` is the occurrence read's act
 * gate for this reader. THROWS when a photo (the master) cannot be signed: a
 * broken image is never handed out; a failed thumbnail falls back to null.
 */
export async function buildEvidenceBlock(
  ctx: Pick<ServiceContext, 'userId' | 'role'>,
  occurrence: { canAct: boolean; resolvedAt: string | null },
  rows: readonly EvidenceRow[],
): Promise<ExceptionEvidenceBlock> {
  const live = rows.filter((r) => r.removed_at === null);
  const paths: string[] = [];
  for (const r of live) {
    paths.push(r.storage_path);
    if (r.thumbnail_path) paths.push(r.thumbnail_path);
  }
  const signed = await signEvidencePaths(paths);
  const resolved = occurrence.resolvedAt !== null;
  const manager = isManagerOrAbove(ctx.role);
  const photos = live.map((r): ExceptionEvidencePhoto => {
    const url = signed.get(r.storage_path) ?? null;
    if (!url) throw new ServiceError('internal_error', 'Could not sign a photo link.');
    return {
      id: r.id,
      uploadedBy: personFor(r.uploaded_by, r.uploader),
      capturedAt: r.captured_at,
      uploadedAt: r.created_at,
      note: r.note,
      contentType: r.content_type,
      byteSize: Number(r.byte_size),
      url,
      thumbUrl: r.thumbnail_path ? (signed.get(r.thumbnail_path) ?? null) : null,
      canRemove: canRemoveExceptionEvidence({
        resolved,
        canAct: occurrence.canAct,
        removed: false,
        viewerIsUploader: r.uploaded_by !== null && r.uploaded_by === ctx.userId,
        viewerIsManager: manager,
      }),
    };
  });
  return {
    status: 'ok',
    photos,
    liveCount: live.length,
    maxPhotos: EXCEPTION_EVIDENCE_MAX_PHOTOS,
    canAdd: occurrence.canAct && !resolved && live.length < EXCEPTION_EVIDENCE_MAX_PHOTOS,
  };
}

/** Each photo's times, by id, for the timeline's evidence events. */
export function evidenceEventInfo(rows: readonly EvidenceRow[]): Map<string, EvidenceEventInfo> {
  return new Map(
    rows.map((r) => [
      r.id,
      { capturedAt: r.captured_at, uploadedAt: r.created_at, removed: r.removed_at !== null },
    ]),
  );
}
