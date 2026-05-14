import 'server-only';

import type { RecordProcedureVideoInput } from '@stockpilot/core';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

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
// Two TTLs. Thumbnails are short — they're embedded in the list page,
// re-rendered on every reload, and only handed out in batches of 24.
// A 1-hour URL cuts the blast radius if a list response leaks. The
// player URL stays long (24 hours) so a user mid-watch doesn't have
// their stream snapped from under them — and the URL is only minted
// when they hit the detail page, not in bulk.
const SIGNED_URL_THUMBNAIL_TTL_SECONDS = 60 * 60; // 1 hour
const SIGNED_URL_PLAYER_TTL_SECONDS = 24 * 60 * 60; // 24 hours
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
    const videoUrls = await this.signedUrls(
      rows.map((r) => r.storage_path),
      SIGNED_URL_PLAYER_TTL_SECONDS,
    );
    const thumbPaths = rows
      .map((r) => r.thumbnail_path)
      .filter((p): p is string => Boolean(p));
    const thumbUrls = thumbPaths.length > 0
      ? await this.signedUrls(thumbPaths, SIGNED_URL_THUMBNAIL_TTL_SECONDS)
      : new Map();
    return rows.map((r) => ({
      ...r,
      signed_url: videoUrls.get(r.storage_path) ?? null,
      thumbnail_url: r.thumbnail_path ? thumbUrls.get(r.thumbnail_path) ?? null : null,
    }));
  }

  /**
   * Mirror of ItemImagesService.signedUrls. TTL defaults to the THUMBNAIL
   * length (1h) because the list page is the dominant caller; callers
   * needing a longer-lived URL pass `SIGNED_URL_PLAYER_TTL_SECONDS`
   * explicitly.
   */
  async signedUrls(
    paths: string[],
    ttlSeconds: number = SIGNED_URL_THUMBNAIL_TTL_SECONDS,
  ): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase.storage
      .from(PROCEDURE_VIDEOS_BUCKET)
      .createSignedUrls(paths, ttlSeconds);
    if (error) throw new ServiceError('internal_error', error.message);
    const map = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && entry.path) map.set(entry.path, entry.signedUrl);
    }
    return map;
  }

  /** Internal helper. Single-path variant of `signedUrls`. */
  async signedUrlFor(
    storagePath: string,
    ttlSeconds: number = SIGNED_URL_THUMBNAIL_TTL_SECONDS,
  ): Promise<string | null> {
    const urls = await this.signedUrls([storagePath], ttlSeconds);
    return urls.get(storagePath) ?? null;
  }

  /**
   * Records a video row AFTER the client has already uploaded the file to
   * Supabase storage at the given path. Manager+ only. Emits a
   * `procedure.video.added` audit event.
   */
  async record(input: RecordProcedureVideoInput): Promise<ProcedureVideoRow> {
    assertPermission(this.ctx, 'categories:manage');

    // Defense-in-depth: the action schema accepts `storagePath` as a
    // bare string, so a hostile caller could pass another org's path
    // (or *any* path) here. Storage RLS still refuses signed URLs for
    // cross-org paths, but we'd be inserting a pointer row tagged with
    // OUR org pointing at THEIR file. Two checks:
    //   1) the org prefix must match the caller's org
    //   2) the SECOND segment must match the target procedure id —
    //      otherwise a manager could record a video on procedure A that
    //      actually points at procedure B's storage folder
    const orgPrefix = `${this.ctx.organizationId}/`;
    if (!input.storagePath.startsWith(orgPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — wrong org prefix.',
      );
    }
    const procPrefix = `${this.ctx.organizationId}/${input.procedureId}/`;
    if (!input.storagePath.startsWith(procPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — does not match this procedure.',
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
