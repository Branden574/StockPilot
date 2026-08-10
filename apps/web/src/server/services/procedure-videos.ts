import 'server-only';

import { unstable_cache } from 'next/cache';

import type { RecordProcedureVideoInput } from '@stockpilot/core';

import { isValidStoragePath, procedureVideoPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export interface ProcedureVideoRow {
  id: string;
  procedure_id: string;
  title: string | null;
  storage_path: string;
  thumbnail_path: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  mime_type: string | null;
  order_idx: number;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface ProcedureVideoWithUrl extends ProcedureVideoRow {
  signed_url: string | null;
  thumbnail_url: string | null;
}

const PROCEDURE_VIDEOS_BUCKET = 'procedure-videos';
// Signed URLs are minted once per path and CACHED (sign 7d / cache 6d) so
// every render returns the SAME URL. The old per-request 1h/24h URLs meant
// every list/detail reload minted fresh tokens — the browser cache never hit,
// so all ~24 grid tiles re-range-fetched video metadata on every visit and a
// mid-watch stream could expire under the viewer. 7 days (vs item-images'
// 30) keeps the leak blast-radius bounded — these are the org's internal
// training videos, and a leaked URL still dies within a week.
const SIGNED_URL_TTL_SEC = 7 * 24 * 60 * 60;
const SIGNED_URL_CACHE_SEC = 6 * 24 * 60 * 60;

// THROWS on failure so unstable_cache never persists a null for 6 days
// (recurring-bug pattern #6). The wrapper below catches → null per path.
const signProcedureVideoPath = unstable_cache(
  async (storagePath: string): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(PROCEDURE_VIDEOS_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (error || !data?.signedUrl) {
      throw new Error(`sign video failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  ['procedure-video-signed-url-v1'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['procedure-video-signed-url'] },
);
async function cachedVideoUrl(storagePath: string): Promise<string | null> {
  try {
    return await signProcedureVideoPath(storagePath);
  } catch (err) {
    console.warn(
      `[procedure-videos] sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
// Max retry attempts on a unique-violation conflict when computing
// order_idx. Two concurrent uploads can race on max(order_idx)+1; the
// (procedure_id, order_idx) unique constraint added in migration 0089
// rejects the loser with 23505 and we retry once with a fresh max.
const ORDER_IDX_MAX_ATTEMPTS = 3;

/**
 * ProcedureVideosService — writes are gated on `categories:manage`
 * (the manager+ permission, matching the migration's manager-level RLS).
 * The client uploads the actual file directly to Supabase storage and
 * then calls `record(...)` to insert the DB row. Reads mint a fresh
 * 7-day signed URL per call — mirrors ItemImagesService.signedUrls.
 */
export class ProcedureVideosService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ProcedureVideosService(await withContext());
  }

  /** List of video rows for a procedure, ordered by order_idx asc. */
  async listForProcedure(procedureId: string): Promise<ProcedureVideoRow[]> {
    assertModuleEnabled(this.ctx, 'procedures');
    const { data, error } = await this.ctx.supabase
      .from('procedure_videos')
      .select(
        'id, procedure_id, title, storage_path, thumbnail_path, duration_seconds, size_bytes, mime_type, order_idx, uploaded_by, uploaded_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('procedure_id', procedureId)
      .order('order_idx', { ascending: true })
      .order('uploaded_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as ProcedureVideoRow[];
  }

  /**
   * Returns the same rows as listForProcedure plus a freshly-minted signed
   * URL per storage path (and per thumbnail if present). Two storage calls
   * total — one for the player URLs (24h), one for the thumbnails (1h).
   */
  async listForProcedureWithUrls(procedureId: string): Promise<ProcedureVideoWithUrl[]> {
    const rows = await this.listForProcedure(procedureId);
    if (rows.length === 0) return [];
    const videoUrls = await this.signedUrls(rows.map((r) => r.storage_path));
    const thumbPaths = rows
      .map((r) => r.thumbnail_path)
      .filter((p): p is string => Boolean(p));
    const thumbUrls = thumbPaths.length > 0
      ? await this.signedUrls(thumbPaths)
      : new Map<string, string>();
    return rows.map((r) => ({
      ...r,
      signed_url: videoUrls.get(r.storage_path) ?? null,
      thumbnail_url: r.thumbnail_path ? thumbUrls.get(r.thumbnail_path) ?? null : null,
    }));
  }

  /**
   * Signed URL per path, via the module-level 6-day cache — the same URL
   * comes back for the same path across renders, so the browser can actually
   * cache the bytes. Signing is org-agnostic (authorization happened in the
   * RLS-scoped row selects that produced these paths).
   */
  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    const entries = await Promise.all(
      paths.map(async (p) => {
        const url = await cachedVideoUrl(p);
        return url ? ([p, url] as const) : null;
      }),
    );
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry) map.set(entry[0], entry[1]);
    }
    return map;
  }

  /** Internal helper. Single-path variant of `signedUrls`. */
  async signedUrlFor(storagePath: string): Promise<string | null> {
    return cachedVideoUrl(storagePath);
  }

  /**
   * Records a video row AFTER the client has already uploaded the file to
   * Supabase storage at the given path. Manager+ only. Emits a
   * `procedure.video.added` audit event.
   */
  async record(input: RecordProcedureVideoInput): Promise<ProcedureVideoRow> {
    assertModuleEnabled(this.ctx, 'procedures');
    assertPermission(this.ctx, 'categories:manage');

    // HI-8: the action schema accepts `storagePath` as a bare string, so a
    // hostile caller could pass another org's path — or *any* path. This used
    // to be two `startsWith` prefix checks (org, then org+procedure), and a
    // prefix check says nothing about the rest of the string:
    // `${org}/${proc}/../../../item-images/<victim-org>/<victim-item>/cover.jpg`
    // satisfies BOTH, because @supabase/storage-js interpolates the path into
    // a fetch() URL whose `..` segments the WHATWG parser resolves before the
    // request leaves Node — so the row pointed outside the procedure folder,
    // outside the org, and outside the bucket, and `signedUrls()` below signs
    // it with the SERVICE-ROLE client, which RLS cannot stop.
    //
    // `procedureVideoPathShape` pins the whole string to `{org}/{proc}/{file}`
    // from the server's own org id and this call's procedure id, so it carries
    // both of the old checks' intent and admits no traversal encoding.
    //
    // The org-prefix check is kept as a SEPARATE first step purely to preserve
    // its distinct error copy: a caller who sent another org's path gets the
    // "wrong org prefix" message it has always gotten, rather than the
    // procedure-mismatch one.
    const orgPrefix = `${this.ctx.organizationId}/`;
    if (!input.storagePath.startsWith(orgPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — wrong org prefix.',
      );
    }
    const pathShape = procedureVideoPathShape(this.ctx.organizationId, input.procedureId);
    if (!isValidStoragePath(input.storagePath, pathShape)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — does not match this procedure.',
      );
    }
    // The poster (if captured) is minted next to the video as
    // `{uuid}.poster.jpg`, so it takes the SAME shape — same gate.
    if (input.thumbnailPath && !isValidStoragePath(input.thumbnailPath, pathShape)) {
      throw new ServiceError(
        'validation_error',
        'Invalid thumbnail path — does not match this procedure.',
      );
    }

    // Verify the parent procedure exists in the current org. RLS would
    // already block insert if it didn't, but this gives a friendlier
    // not_found error and keeps the storage path orphan-check tight.
    const { data: proc, error: procErr } = await this.ctx.supabase
      .from('procedures')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.procedureId)
      .maybeSingle();
    if (procErr) throw new ServiceError('internal_error', procErr.message);
    if (!proc) throw new ServiceError('not_found', 'Procedure not found');

    // Insert with retry-on-unique-conflict. Two concurrent uploads can
    // both read max=N and try to insert at N+1; the unique constraint
    // added in migration 0089 turns the loser into a 23505, which we
    // recover from by re-reading the max and retrying. After
    // ORDER_IDX_MAX_ATTEMPTS we give up — the caller can re-submit.
    const explicitIdx = input.orderIdx;
    let lastErrorMsg = '';
    for (let attempt = 0; attempt < ORDER_IDX_MAX_ATTEMPTS; attempt += 1) {
      let orderIdx = explicitIdx;
      if (orderIdx === undefined) {
        const { data: maxRow } = await this.ctx.supabase
          .from('procedure_videos')
          .select('order_idx')
          .eq('organization_id', this.ctx.organizationId)
          .eq('procedure_id', input.procedureId)
          .order('order_idx', { ascending: false })
          .limit(1)
          .maybeSingle();
        orderIdx = ((maxRow?.order_idx as number | undefined) ?? -1) + 1;
      }

      const { data, error } = await this.ctx.supabase
        .from('procedure_videos')
        .insert({
          organization_id: this.ctx.organizationId,
          procedure_id: input.procedureId,
          title: input.title ?? null,
          storage_path: input.storagePath,
          thumbnail_path: input.thumbnailPath ?? null,
          duration_seconds: input.durationSeconds ?? null,
          size_bytes: input.sizeBytes ?? null,
          mime_type: input.mimeType ?? null,
          order_idx: orderIdx,
          uploaded_by: this.ctx.userId,
        })
        .select(
          'id, procedure_id, title, storage_path, thumbnail_path, duration_seconds, size_bytes, mime_type, order_idx, uploaded_by, uploaded_at',
        )
        .single();
      if (!error) {
        void audit(
          {
            event: 'procedure.video.added',
            entityType: 'procedure',
            entityId: input.procedureId,
            extra: { video_id: (data as ProcedureVideoRow).id, storage_path: input.storagePath },
          },
          this.ctx,
        );
        return data as ProcedureVideoRow;
      }
      // 23505 on (procedure_id, order_idx) → another upload just took
      // our slot. Retry with a fresh max. Any other code is a real
      // error and we bail.
      if (error.code !== '23505' || explicitIdx !== undefined) {
        throw new ServiceError('internal_error', error.message);
      }
      lastErrorMsg = error.message;
    }
    throw new ServiceError(
      'conflict',
      lastErrorMsg
        ? `Couldn't slot the video into the procedure (raced too many times): ${lastErrorMsg}`
        : 'Couldn\'t slot the video into the procedure.',
    );
  }

  /**
   * Deletes a video. Removes the storage file FIRST (best-effort —
   * orphan-DB rows are easier to clean up than orphan storage files),
   * then the DB row. Manager+ only.
   */
  async delete(id: string): Promise<{ procedureId: string }> {
    assertModuleEnabled(this.ctx, 'procedures');
    assertPermission(this.ctx, 'categories:manage');
    const { data: row, error: readErr } = await this.ctx.supabase
      .from('procedure_videos')
      .select('id, procedure_id, storage_path, thumbnail_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    if (!row) throw new ServiceError('not_found', 'Video not found');

    const paths: string[] = [row.storage_path as string];
    if (row.thumbnail_path) paths.push(row.thumbnail_path as string);
    // Best-effort delete from storage. If the path is already gone the
    // DB row delete below still succeeds and the user isn't blocked.
    await this.ctx.supabase.storage.from(PROCEDURE_VIDEOS_BUCKET).remove(paths);

    const { error: delErr } = await this.ctx.supabase
      .from('procedure_videos')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (delErr) throw new ServiceError('internal_error', delErr.message);

    void audit(
      {
        event: 'procedure.video.removed',
        entityType: 'procedure',
        entityId: row.procedure_id as string,
        extra: { video_id: id },
      },
      this.ctx,
    );
    return { procedureId: row.procedure_id as string };
  }
}
