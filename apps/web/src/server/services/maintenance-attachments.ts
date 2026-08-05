import 'server-only';

import { can, MAINTENANCE_MAX_PHOTOS, MAINTENANCE_MAX_PHOTO_BYTES } from '@stockpilot/core';

import { sanitizeFilenameSegment } from '@/lib/exports/filename';
import { MIME_FOR_KIND, sniffImage } from '@/lib/image-signature';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';

/** Bucket id from migration 0315 — private, org-prefixed, no select policy.
 *  Every read is a short-lived signed URL minted server-side (never a raw
 *  bucket/public URL). */
const BUCKET = 'maintenance-photos';

const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** In-app display TTL. Deliberately SHORT (1 hour), NOT the 30-day/25-day
 *  cached convention item-images.ts and order-attachments.ts use for stable
 *  public-facing thumbnails — those exist to make a browser/CDN cache hit on
 *  revisits for images that render on every page load. Maintenance photos
 *  are viewed on one request's detail page, are frequently removed, and (per
 *  audit Q7 / landmine 23) must NEVER be embedded in an email or otherwise
 *  outlive a short in-app session — a 25-day cached URL is exactly the kind
 *  of long-lived, irrevocable link that landmine forbids. Never logged (GC 27).
 *  The share-link system (Task 10) is the deliberately-different long-lived,
 *  revocable mechanism for anything that has to survive outside the app. */
const VIEW_URL_TTL_SEC = 60 * 60;

export interface SignedMaintenancePhoto {
  id: string;
  originalFilename: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
}

export class MaintenanceAttachmentsService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * WRITE-path gate shared by mint and finalize (audit Q8 flow): module
   * enabled, caller holds at least `maintenance_requests:submit` (the same
   * low bar as creating a request — also the MFA step-up trigger, via
   * assertPermission), the parent request exists in this org, the caller is
   * either its requester or a manage-holder (mirrors 0314's
   * maintenance_request_attachments_insert/_delete RLS ownership clause),
   * and the request is not archived/cancelled — UNCONDITIONALLY, matching
   * that same RLS policy's `r.archived_at is null and r.cancelled_at is
   * null` clause, which applies regardless of role. Storage's own INSERT
   * policy (0315) only checks the org prefix, not per-request ownership —
   * this check is the ONLY place that boundary is enforced for a fresh
   * mint, since mint never touches the attachments table's RLS at all.
   */
  private async assertParentOwnedAndOpen(requestId: string): Promise<void> {
    assertPermission(this.ctx, 'maintenance_requests:submit');

    const { data, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id, requester_user_id, archived_at, cancelled_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Maintenance request not found');

    const row = data as { requester_user_id: string | null; archived_at: string | null; cancelled_at: string | null };
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    if (!isManager && row.requester_user_id !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Not your request.');
    }
    if (row.archived_at || row.cancelled_at) {
      throw new ServiceError('conflict', 'This request is closed; photos can no longer change.');
    }
  }

  /** Server-minted signed-upload URL (audit Q8) — the client never talks to
   *  Storage without a mint. Rate-limited per user; capped at
   *  MAINTENANCE_MAX_PHOTOS per request (removing a photo frees its slot,
   *  since this re-counts live). Extension allow-listed; HEIC is rejected —
   *  both platforms transcode to JPEG client-side before ever calling this. */
  async createUploadUrl(
    requestId: string,
    args: { fileExt: string; originalFilename: string },
  ): Promise<{
    path: string;
    signedUrl: string;
    token: string;
    thumbPath: string;
    thumbSignedUrl: string;
    thumbToken: string;
  }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    await this.assertParentOwnedAndOpen(requestId);

    const ext = args.fileExt.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new ServiceError(
        'validation_error',
        'Photos must be JPEG, PNG, or WEBP. HEIC is converted on your device before upload.',
      );
    }

    const limit = await checkRateLimit(`maintenance:upload:${this.ctx.userId}`, 60, 60 * 60 * 1000, 'closed');
    if (!limit.allowed) {
      throw new ServiceError('conflict', 'Too many uploads in the last hour. Please try again later.');
    }

    const { count, error: countErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId);
    if (countErr) throw new ServiceError('internal_error', countErr.message);
    if ((count ?? 0) >= MAINTENANCE_MAX_PHOTOS) {
      throw new ServiceError('conflict', `A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`);
    }

    const uuid = crypto.randomUUID();
    const path = `${this.ctx.organizationId}/${requestId}/${uuid}.${ext}`;
    const thumbPath = `${this.ctx.organizationId}/${requestId}/${uuid}-thumb.webp`;
    const [master, thumb] = await Promise.all([
      this.ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(path),
      this.ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(thumbPath),
    ]);
    if (master.error) throw new ServiceError('internal_error', master.error.message);
    if (thumb.error) throw new ServiceError('internal_error', thumb.error.message);
    return {
      path,
      signedUrl: master.data.signedUrl,
      token: master.data.token,
      thumbPath,
      thumbSignedUrl: thumb.data.signedUrl,
      thumbToken: thumb.data.token,
    };
  }

  /**
   * Downloads the just-uploaded object, sniffs REAL bytes (never the
   * client's declared MIME), and records the row. A body that is not the
   * image it claims to be — wrong bytes, or bytes/declared-MIME mismatch,
   * or oversize — is DELETED, never stored, and writes NO row (photo test 6).
   */
  async finalize(
    requestId: string,
    args: { path: string; thumbPath: string | null; originalFilename: string; declaredMime: string },
  ): Promise<{ id: string; width: number | null; height: number | null }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    await this.assertParentOwnedAndOpen(requestId);

    // Re-assert the org+request prefix on the CLIENT-SUPPLIED path — the
    // org segment is never parsed from it, only ever ctx.organizationId
    // compared against it. This must run BEFORE any storage call: a forged
    // path from a hostile client must never even reach `download`.
    const prefix = `${this.ctx.organizationId}/${requestId}/`;
    if (!args.path.startsWith(prefix) || (args.thumbPath && !args.thumbPath.startsWith(prefix))) {
      throw new ServiceError('forbidden', 'Invalid upload path.');
    }

    const admin = createAdminClient();
    const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(args.path);
    // A download failure here also means "the object was never actually
    // uploaded" — the finalize-time existence check (no phantom rows for a
    // mint that was never followed by a real PUT). Nothing to remove.
    if (dlErr || !blob) throw new ServiceError('validation_error', 'invalid_image');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const sniffed = sniffImage(bytes);
    const declaredOk = sniffed !== null && MIME_FOR_KIND[sniffed.kind] === args.declaredMime;
    const sizeOk = bytes.byteLength > 0 && bytes.byteLength <= MAINTENANCE_MAX_PHOTO_BYTES;
    if (!sniffed || !declaredOk || !sizeOk) {
      await admin.storage.from(BUCKET).remove([args.path, ...(args.thumbPath ? [args.thumbPath] : [])]);
      throw new ServiceError('validation_error', 'invalid_image');
    }

    const { data: row, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        maintenance_request_id: requestId,
        storage_path: args.path,
        thumbnail_path: args.thumbPath,
        original_filename: args.originalFilename.slice(0, 300),
        safe_filename: sanitizeFilenameSegment(args.originalFilename).slice(0, 300) || 'photo',
        mime_type: MIME_FOR_KIND[sniffed.kind],
        byte_size: bytes.byteLength,
        width: sniffed.width,
        height: sniffed.height,
        uploaded_by: this.ctx.userId,
        verified_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !row) {
      // An RLS-rejected metadata insert (e.g. the request closed between the
      // guard above and this write) leaves an orphan object — roll it back
      // rather than leave storage holding a file no row will ever reference.
      await admin.storage.from(BUCKET).remove([args.path, ...(args.thumbPath ? [args.thumbPath] : [])]);
      throw new ServiceError('internal_error', error?.message ?? 'Could not record the photo.');
    }

    await audit(
      {
        event: 'maintenance_request.attachment_added',
        entityType: 'maintenance_request',
        entityId: requestId,
        extra: { attachment_id: row.id, byte_size: bytes.byteLength },
      },
      this.ctx,
    );
    return { id: row.id as string, width: sniffed.width, height: sniffed.height };
  }

  /** Deletes the row and both storage objects. Row-confirmed on BOTH the
   *  pre-read and the delete itself (C2/Task 8 lesson): a delete that
   *  affects zero rows — because RLS refused it, not because a Postgres
   *  error occurred — must never be mistaken for success. Without the
   *  second confirm, a caller RLS silently blocked would still see storage
   *  objects removed and an audit event written for a delete that never
   *  happened. */
  async remove(requestId: string, attachmentId: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:submit');

    const { data: att, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id, storage_path, thumbnail_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('id', attachmentId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!att) throw new ServiceError('not_found', 'Photo not found');

    const { data: deleted, error: delErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', attachmentId)
      .select('id')
      .maybeSingle();
    if (delErr) throw new ServiceError('internal_error', delErr.message);
    if (!deleted) {
      // The pre-read above already confirmed this row exists in-org — a
      // zero-row delete result means the write itself was refused (RLS:
      // not the requester/manager/manage, or the request closed between
      // the read and this write). Conflict, not not_found.
      throw new ServiceError('conflict', 'This photo could not be removed. Reload and try again.');
    }

    const admin = createAdminClient();
    const storagePath = att.storage_path as string;
    const thumbnailPath = att.thumbnail_path as string | null;
    await admin.storage.from(BUCKET).remove([storagePath, ...(thumbnailPath ? [thumbnailPath] : [])]);

    await audit(
      {
        event: 'maintenance_request.attachment_removed',
        entityType: 'maintenance_request',
        entityId: requestId,
        extra: { attachment_id: attachmentId },
      },
      this.ctx,
    );
  }

  /**
   * Short-lived signed URLs, minted fresh per call via the ADMIN client
   * AFTER the caller's RLS-visible row read (authorization already happened
   * there — signing a path is org-agnostic). THROWS on a signing failure
   * (never returns a partial/broken URL — recurring bug #6: a caller must
   * never be handed a `null` that renders as a broken image).
   *
   * NOT module-gated (0314 Q3, same reasoning as maintenance-requests.ts's
   * list()/get()/listNotes()): attachment READS ride RLS + signed URLs and
   * stay visible after a module disable. Only the write paths above
   * (createUploadUrl/finalize/remove) carry assertModuleEnabled — do not
   * "restore" a module gate here.
   */
  async signedViewUrls(requestId: string): Promise<SignedMaintenancePhoto[]> {
    const { data: rows, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id, storage_path, thumbnail_path, original_filename, width, height')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const admin = createAdminClient();
    const out: SignedMaintenancePhoto[] = [];
    for (const r of (rows ?? []) as Record<string, unknown>[]) {
      const storagePath = r.storage_path as string;
      const master = await admin.storage.from(BUCKET).createSignedUrl(storagePath, VIEW_URL_TTL_SEC);
      if (master.error || !master.data) {
        throw new ServiceError('internal_error', 'Could not sign photo URL');
      }
      // The thumb is a nice-to-have variant of the SAME photo, not a
      // distinct asset — unlike a failed master (which IS the photo), a
      // failed thumb sign falls back to null so the caller renders the
      // master instead of losing the whole row over a secondary asset.
      let thumbUrl: string | null = null;
      const thumbnailPath = r.thumbnail_path as string | null;
      if (thumbnailPath) {
        const thumb = await admin.storage.from(BUCKET).createSignedUrl(thumbnailPath, VIEW_URL_TTL_SEC);
        if (!thumb.error && thumb.data) thumbUrl = thumb.data.signedUrl;
      }
      out.push({
        id: r.id as string,
        originalFilename: r.original_filename as string,
        url: master.data.signedUrl,
        thumbUrl,
        width: (r.width as number | null) ?? null,
        height: (r.height as number | null) ?? null,
      });
    }
    return out;
  }
}
