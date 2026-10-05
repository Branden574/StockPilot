import 'server-only';

import {
  can,
  formatMaintenanceRequestNumber,
  MAINTENANCE_ATTACHMENT_KINDS,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_MAX_PHOTO_BYTES,
  type MaintenanceAttachmentKind,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { sanitizeFilenameSegment } from '@/lib/exports/filename';
import { reencodeWithoutMetadata } from '@/lib/image-reencode';
import { isSniffedKindAllowedInBucket, MIME_FOR_KIND, sniffImage } from '@/lib/image-signature';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchObjectPrefix } from '@/lib/storage-object-prefix';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';
import { notifyMaintenanceEvent } from './maintenance-notify';

/** Bucket id from migration 0315 — private, org-prefixed, no select policy.
 *  Every read is a short-lived signed URL minted server-side (never a raw
 *  bucket/public URL). */
const BUCKET = 'maintenance-photos';

const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** UUID shape `crypto.randomUUID()` produces — the ONLY thing that may sit
 *  between the request-id segment and the extension in a finalize path. */
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Escapes a string for literal interpolation into a `RegExp` source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Derives the deterministic thumbnail path from a validated master path —
 *  same directory, `-thumb.webp` suffix, matching the exact scheme
 *  `createUploadUrl` mints (CRITICAL 1c: thumbPath is never trusted from the
 *  client — see `finalize` below). Must only be called on a path that has
 *  already passed `validateFinalizePath`. */
function deriveThumbPath(path: string): string {
  return path.replace(/\.(jpg|jpeg|png|webp)$/, '-thumb.webp');
}

/** Every name of ONE upload: its uuid with each allowed extension. They all
 *  derive the same thumbnail name, so "is this upload recorded?" asks for all
 *  four. Only called on a path that passed `validateFinalizePath`. */
function uploadNames(path: string): string[] {
  const stem = path.replace(/\.(jpg|jpeg|png|webp)$/, '');
  return ['jpg', 'jpeg', 'png', 'webp'].map((ext) => `${stem}.${ext}`);
}

/** Finalizes one person may send per FINALIZE_LIMIT_WINDOW_MS. Each finalize
 *  now decodes and re-encodes up to the bucket's 10 MB (and a small file can
 *  decode to a very large image), and the bucket's INSERT policy lets a member
 *  put objects without a mint, so the mint's own limit does not bound this
 *  work. The same numbers as exception evidence's finalize, and CLOSED: when
 *  the limiter cannot answer, nothing is read or re-encoded. */
const FINALIZE_LIMIT = 30;
const FINALIZE_LIMIT_WINDOW_MS = 60 * 1000;

/** A photo of more pixels than this is refused before it is decoded (review
 *  2026-09-27). A small file can decode to a very large image, and the
 *  re-encode holds it all in memory: measured on sharp 0.35.4, a 178 KB
 *  10000x10000 WEBP with EXIF orientation 6 peaked at 1.78 GB, a 50 MP one at
 *  0.94 GB, a 24.5 MP one at 0.57 GB. A 48 MP phone original (48.8e6) still
 *  fits; the apps send at most 2048 px (web) and 1600 px (phone) unless they
 *  fall back to the original. Checked from the header before anything is read
 *  whole when the sniff gives the size (JPEG, PNG), and by the re-encode
 *  itself, from the header, for every format (a WEBP's size is not sniffed). */
const MAX_INPUT_PIXELS = 50_000_000;

/** A JPEG or WEBP whose clean master comes out over the cap is re-encoded once
 *  more at this quality before it is refused (review 2026-09-27): the re-encode
 *  at quality 90 makes a photo saved at a lower quality bigger. Measured on a
 *  30 MP photo-like JPEG saved at 75: 8.87 MB, 10.39 MB at 90 (over the 10 MB
 *  cap), 7.70 MB at 75; a WEBP saved at 70: 9.42 MB, 11.94 MB at 90, 8.92 MB
 *  at 75 (80 still left it over). PNG is lossless: no quality to lower. */
const OVER_CAP_RETRY_QUALITY = 75;

const ALREADY_RECORDED = 'This photo was already recorded.';

type AdminClient = ReturnType<typeof createAdminClient>;
type AdminBucket = ReturnType<AdminClient['storage']['from']>;

/** The whole object, or null when it cannot be read. */
async function downloadWhole(store: AdminBucket, path: string): Promise<Uint8Array | null> {
  try {
    const { data, error } = await store.download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Validates a client-supplied storage path BEFORE any storage call
 * (CRITICAL 1 — path-traversal past the org/bucket boundary, proven
 * end-to-end: @supabase/storage-js interpolates `path` straight into a
 * fetch() URL, and the WHATWG URL parser strips `..` / `%2e%2e` segments
 * BEFORE the request leaves Node. A `startsWith(prefix)` check alone is
 * satisfiable by `org/req/../../victim-org/victim-req/photo.png` — it
 * passes startsWith, downloads with the SERVICE-ROLE client (RLS cannot
 * stop it), and is then stored and signed. A `%2e%2e`-encoded variant
 * escapes the BUCKET entirely, e.g. into item-images, whose paths are
 * guessable (books-import.ts writes item-images/{orgId}/{itemId}/cover.{ext}).
 *
 * Two independent layers, deliberately redundant:
 *   (b) a belt-and-braces character/segment denylist, so a subtle bug in
 *       the regex below (e.g. a missing anchor) is not the ONLY thing
 *       standing between a hostile path and a storage call;
 *   (a) a STRICT SHAPE match — the path must be EXACTLY
 *       `{org}/{requestId}/{uuid}.{ext}`, built from the ctx org id and the
 *       already-uuid-validated requestId (both regex-escaped), nothing more.
 */
function validateFinalizePath(organizationId: string, requestId: string, path: string): void {
  const segments = path.split('/');
  if (
    path.includes('%') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes('//') ||
    segments.some((seg) => seg === '.' || seg === '..' || seg === '')
  ) {
    throw new ServiceError('forbidden', 'Invalid upload path.');
  }

  const shape = new RegExp(
    `^${escapeRegExp(organizationId)}/${escapeRegExp(requestId)}/${UUID_SHAPE}\\.(jpg|jpeg|png|webp)$`,
  );
  if (!shape.test(path)) {
    throw new ServiceError('forbidden', 'Invalid upload path.');
  }
}

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
  kind: MaintenanceAttachmentKind;
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
   *
   * Returns request_number/created_at/subject alongside the existence/
   * ownership/open checks — Task 21's finalize() failure hook needs them for
   * a photo_rejected notification title/body, and reading them here (they
   * ride the SAME select this method already makes) avoids a second round
   * trip just to re-fetch what this call already touched. createUploadUrl
   * doesn't need them and simply ignores the return value.
   *
   * Migration 0317: `resolved_at` closes the request the same way
   * `archived_at`/`cancelled_at` already do — the SAME message, since the
   * caller doesn't need to know WHICH closed state it hit, only that photos
   * can no longer change. Mirrors the 0317 attachments INSERT/DELETE RLS
   * predicate exactly (`r.archived_at is null and r.cancelled_at is null
   * and r.resolved_at is null`) — defense in depth, both directions.
   */
  private async assertParentOwnedAndOpen(
    requestId: string,
  ): Promise<{ requestNumber: number | null; createdAt: string | null; subject: string | null }> {
    assertPermission(this.ctx, 'maintenance_requests:submit');

    const { data, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id, requester_user_id, archived_at, cancelled_at, resolved_at, request_number, created_at, subject')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Maintenance request not found');

    const row = data as {
      requester_user_id: string | null;
      archived_at: string | null;
      cancelled_at: string | null;
      resolved_at: string | null;
      request_number: number | null;
      created_at: string | null;
      subject: string | null;
    };
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    if (!isManager && row.requester_user_id !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Not your request.');
    }
    if (row.archived_at || row.cancelled_at || row.resolved_at) {
      throw new ServiceError('conflict', 'This request is closed; photos can no longer change.');
    }
    return {
      requestNumber: row.request_number ?? null,
      createdAt: row.created_at ?? null,
      subject: row.subject ?? null,
    };
  }

  /**
   * Validates + authorizes `kind` (migration 0317/spec §2.2), shared by
   * `createUploadUrl` and `finalize`. Defaults to `'requester'` when
   * omitted — byte-for-byte the pre-kind behavior. `'resolution'` requires
   * `maintenance_requests:manage`, mirroring the 0317 attachments INSERT
   * RLS `with check` clause exactly (`kind = 'requester' or
   * has_permission(..., 'maintenance_requests:manage')`) — defense in
   * depth: a requester who somehow reached this far with kind='resolution'
   * gets a clean `forbidden` from the SERVICE, never a storage write that
   * only dies later at the RLS layer. Called immediately after
   * `assertParentOwnedAndOpen`, before any rate-limit check or storage
   * call, so an unauthorized kind never spends either budget.
   */
  private validateKind(kind: MaintenanceAttachmentKind | undefined): MaintenanceAttachmentKind {
    const resolved = kind ?? 'requester';
    if (!MAINTENANCE_ATTACHMENT_KINDS.includes(resolved)) {
      throw new ServiceError(
        'validation_error',
        `Invalid photo kind. Must be one of: ${MAINTENANCE_ATTACHMENT_KINDS.join(', ')}.`,
      );
    }
    if (resolved === 'resolution' && !can(this.ctx, 'maintenance_requests:manage')) {
      throw new ServiceError('forbidden', 'Only a manage-holder may attach resolution proof photos.');
    }
    return resolved;
  }

  /** Task 21: fire-and-forget photo_rejected notification to the uploader.
   *  Never awaited by finalize() — a notify failure must never delay or
   *  fail the (already-decided) invalid_image throw that follows it. */
  private notifyPhotoRejected(
    requestId: string,
    parent: { requestNumber: number | null; createdAt: string | null; subject: string | null },
  ): void {
    const requestHandle =
      formatMaintenanceRequestNumber(parent.requestNumber, parent.createdAt) ?? `MR-${requestId.slice(0, 8)}`;
    void notifyMaintenanceEvent({
      organizationId: this.ctx.organizationId,
      event: 'photo_rejected',
      requestId,
      requestHandle,
      subject: parent.subject ?? '',
      actorUserId: this.ctx.userId,
      targetUserId: this.ctx.userId,
    }).catch((err) => {
      void reportError(err instanceof Error ? err : new Error(String(err)), {
        tag: 'maintenance_notify.emit_failed',
        extra: { event: 'photo_rejected', requestId },
      });
    });
  }

  /** The storage paths recorded under this upload's NAME: its uuid with any
   *  of the four extensions (they all derive the same thumbnail name). Read
   *  with the service role, so no row is missed for being out of the caller's
   *  sight. A failed look THROWS (internal_error): it is never taken for
   *  "nothing recorded". Only called on a path that passed
   *  `validateFinalizePath`. */
  private async recordedUploadNames(admin: AdminClient, path: string): Promise<string[]> {
    const { data, error } = await admin
      .from('maintenance_request_attachments')
      .select('storage_path')
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: the four extensions of one upload name (jpg, jpeg, png, webp)
      .in('storage_path', uploadNames(path))
      .limit(4);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<{ storage_path: string }>).map((r) => r.storage_path);
  }

  /** Server-minted signed-upload URL (audit Q8) — the client never talks to
   *  Storage without a mint. Rate-limited per user; capped at
   *  MAINTENANCE_MAX_PHOTOS per request (removing a photo frees its slot,
   *  since this re-counts live). Extension allow-listed; HEIC is rejected —
   *  both platforms transcode to JPEG client-side before ever calling this. */
  async createUploadUrl(
    requestId: string,
    args: { fileExt: string; originalFilename: string; kind?: MaintenanceAttachmentKind },
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
    const kind = this.validateKind(args.kind);

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

    // Spec §2.2 — MAINTENANCE_MAX_PHOTOS applies PER KIND: requester photos
    // and resolution proof each get their own 8-photo budget on the same
    // request, so the count query is scoped by `kind` too.
    const { count, error: countErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('kind', kind);
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
   * Range-reads the just-uploaded object's leading bytes, sniffs REAL bytes
   * (never the client's declared MIME), re-encodes the photo WITHOUT its
   * metadata, and records the row. A body that is not the image it claims to
   * be — wrong bytes, or bytes/declared-MIME mismatch, or oversize — is
   * DELETED, never stored, and writes NO row (photo test 6).
   *
   * ═══ PRIVACY: WHAT IS STORED CARRIES NO METADATA ═══
   * A phone photo's EXIF can say where it was taken (GPS), with which device,
   * and by whom, and the clients do not always remove it: the web uploads the
   * ORIGINAL file when its canvas re-encode is not smaller, cannot decode it,
   * or has no canvas (lib/image-variants.ts); the iOS picker returns a WEBP
   * byte for byte and lib/image-resize.ts uploads small JPEG/PNG/WEBP
   * untouched; Android's picker copies EXIF, GPS included. So after the byte
   * checks, finalize reads the whole object (at most the bucket's 10 MB),
   * re-encodes it with lib/image-reencode.ts (the step exception evidence
   * uses: orientation applied to the pixels, then no EXIF, GPS, XMP, IPTC or
   * ICC), and writes the clean photo OVER the upload. The thumbnail is made
   * from the clean photo on the server and written at the name the mint
   * handed out ({uuid}-thumb.webp, derived below exactly as before),
   * replacing whatever the client sent there (the web and phone still PUT
   * their own before finalize; the ticket cannot replace an existing object,
   * because the mint signs without upsert). The row describes the STORED
   * file: its byte_size, and its width/height after orientation.
   *
   * A recorded upload is never read, rewritten or deleted by a later finalize
   * (step 0). Every refusal after that deletes the upload (still the
   * original, GPS included) and the thumbnail name, and records nothing,
   * through `refuse`, which looks first (review 2026-09-27: two finalizes of
   * one upload at once): a photo recorded at this path meanwhile keeps its
   * files and the answer is "already recorded"; a recorded sibling keeps the
   * thumbnail name they share; a failed look deletes nothing. Not deleted
   * either: a 23505 (another finalize of the same upload won the row), and an
   * upload that changed between the range read and the whole read (only
   * another finalize writes over an upload; it is about to record it).
   */
  async finalize(
    requestId: string,
    args: { path: string; originalFilename: string; declaredMime: string; kind?: MaintenanceAttachmentKind },
  ): Promise<{ id: string; width: number | null; height: number | null }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const parent = await this.assertParentOwnedAndOpen(requestId);
    // Manage-gated for kind='resolution' BEFORE any storage call (validateKind's
    // own doc comment) — a requester who reaches finalize with kind='resolution'
    // gets a clean forbidden here, never a download/sniff/insert attempt that
    // would only die later at the RLS layer.
    const kind = this.validateKind(args.kind);

    // CRITICAL 1 — strict shape validation BEFORE any storage call. See
    // validateFinalizePath's own doc for why a prefix check is not enough.
    validateFinalizePath(this.ctx.organizationId, requestId, args.path);
    // CRITICAL 1c — thumbPath is NEVER accepted from the client. It is
    // derived deterministically from the now-validated master path, which
    // reproduces exactly what createUploadUrl minted for the same uuid (the
    // client cannot point it anywhere else, because there is nothing left
    // for it to supply).
    const thumbPath = deriveThumbPath(args.path);

    const admin = createAdminClient();
    const store = admin.storage.from(BUCKET);

    // 0. A recorded upload is never touched again. The steps below write over
    //    the upload and its thumbnail name, so without this a second finalize
    //    of a recorded photo (a retry after a lost answer) would rewrite its
    //    file, and at the cap the refusal below would DELETE it. The four
    //    extensions of this upload's uuid share one thumbnail name, so a
    //    recorded sibling (only a direct PUT can make one: every mint is a
    //    fresh uuid) refuses this upload too, deleting only this upload. Read
    //    with the service role, so no row is missed for being out of the
    //    caller's sight; a failed look touches nothing.
    const recordedPaths = await this.recordedUploadNames(admin, args.path);
    if (recordedPaths.includes(args.path)) {
      throw new ServiceError('conflict', ALREADY_RECORDED);
    }
    if (recordedPaths.length > 0) {
      await store.remove([args.path]);
      throw new ServiceError('forbidden', 'Invalid upload path.');
    }

    /**
     * THE cleanup for every refusal from here on. Step 0 saw nothing
     * recorded, but another finalize of this upload may have recorded it
     * since (review 2026-09-27), so it looks again before deleting:
     *   - a photo recorded at this path: its files are kept, nothing is
     *     deleted, and the answer is "already recorded";
     *   - a recorded sibling (another extension of this uuid): only this
     *     upload is deleted, never the thumbnail name they share;
     *   - the look fails: nothing is deleted (an orphan nobody can read is
     *     safer than a recorded photo with no file) and the refusal stands.
     * Otherwise the upload and the thumbnail name are deleted, as before, and
     * `notify` tells the uploader.
     */
    const refuse = async (err: ServiceError, notify: boolean): Promise<never> => {
      let recorded: string[];
      try {
        recorded = await this.recordedUploadNames(admin, args.path);
      } catch (lookErr) {
        void reportError(lookErr instanceof Error ? lookErr : new Error(String(lookErr)), {
          tag: 'maintenance.finalize_record_unknown',
          organizationId: this.ctx.organizationId,
          extra: { requestId },
        });
        throw err;
      }
      if (recorded.includes(args.path)) throw new ServiceError('conflict', ALREADY_RECORDED);
      await store.remove(recorded.length > 0 ? [args.path] : [args.path, thumbPath]);
      if (notify) this.notifyPhotoRejected(requestId, parent);
      throw err;
    };

    // The per-person finalize limit (FINALIZE_LIMIT), CLOSED. A maintenance
    // retry starts again from a new mint, so the refused upload (still the
    // original) is deleted rather than kept for a resend.
    const limit = await checkRateLimit(
      `maintenance:finalize:${this.ctx.userId}`,
      FINALIZE_LIMIT,
      FINALIZE_LIMIT_WINDOW_MS,
      'closed',
    );
    if (!limit.allowed) {
      return refuse(
        new ServiceError('conflict', 'Too many photos in the last minute. Please wait a moment and try again.'),
        false,
      );
    }

    // Range read (fetchObjectPrefix), not a full download: the sniff verdict
    // lives in the leading 4 KB for everything but metadata-heavy JPEGs (the
    // helper widens to a full read on its own for those), so a fake or an
    // oversize object is refused before anything is read whole. The whole
    // read the re-encode needs comes after these checks and the cap (below).
    // `totalSize` is the
    // object's FULL size from storage's own response headers — it is what the
    // size gate uses below, never the prefix length.
    const head = await fetchObjectPrefix(store, args.path);
    // A prefix-read failure here also means "the object was never actually
    // uploaded" (signing a nonexistent object errors) — the finalize-time
    // existence check (no phantom rows for a mint that was never followed by
    // a real PUT). Nothing to remove.
    if (!head) {
      this.notifyPhotoRejected(requestId, parent);
      throw new ServiceError('validation_error', 'invalid_image');
    }

    const sniffed = sniffImage(head.prefix);
    const declaredOk = sniffed !== null && MIME_FOR_KIND[sniffed.kind] === args.declaredMime;
    const sizeOk = head.totalSize > 0 && head.totalSize <= MAINTENANCE_MAX_PHOTO_BYTES;
    // MAX_INPUT_PIXELS, from the header, before anything is read whole. A
    // WEBP's size is not sniffed (null); the re-encode refuses it from its
    // own header below.
    const pixelsOk =
      sniffed?.width == null ||
      sniffed.height == null ||
      sniffed.width * sniffed.height <= MAX_INPUT_PIXELS;
    if (!sniffed || !declaredOk || !sizeOk || !pixelsOk) {
      return refuse(new ServiceError('validation_error', 'invalid_image'), true);
    }

    // IMPORTANT 3 — cap re-check immediately before the insert. Mint's own
    // count check (createUploadUrl above) only protects the MINT step: 0315
    // lets any accepted org member PUT directly to storage under the org
    // prefix, bypassing mint altogether, and even through mint a caller can
    // request MAINTENANCE_MAX_PHOTOS signed-upload URLs concurrently (each
    // individually under the cap at mint time) and finalize all of them.
    // This is the last gate before the row that would push the request over
    // the cap gets written — re-check LIVE, not the count mint saw. Scoped
    // by `kind` (spec §2.2 — the cap applies per kind, so 8 canned
    // 'requester' rows must never block a 'resolution' mint or finalize).
    const { count, error: countErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('kind', kind);
    if (countErr) throw new ServiceError('internal_error', countErr.message);
    if ((count ?? 0) >= MAINTENANCE_MAX_PHOTOS) {
      return refuse(
        new ServiceError('conflict', `A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`),
        false,
      );
    }

    // PRIVACY (see the doc comment): re-encode WITHOUT metadata and write the
    // clean photo and its server-made thumbnail back. Any failure here is a
    // refusal like the byte checks above: the upload and the thumbnail name
    // are deleted, the uploader is told, and nothing is recorded.
    const reject = (): Promise<never> =>
      refuse(new ServiceError('validation_error', 'invalid_image'), true);
    // The whole object: the range read already holds it when it fits in the
    // window (or when the helper widened to a full read); otherwise one
    // download (at most MAINTENANCE_MAX_PHOTO_BYTES, the bucket's own cap).
    const whole =
      head.prefix.byteLength === head.totalSize ? head.prefix : await downloadWhole(store, args.path);
    if (!whole) return reject();
    if (whole.byteLength !== head.totalSize) {
      // Not the object the range read measured. Nobody but the service role
      // can change an upload (the bucket has no UPDATE policy), so another
      // finalize of this upload has written its clean photo over it and is
      // about to record it: deleting here would delete that photo's files
      // (review 2026-09-27). Nothing is deleted, written or recorded.
      throw new ServiceError('conflict', 'This photo is already being saved.');
    }
    const wholeSniff = sniffImage(whole);
    if (
      wholeSniff?.kind !== sniffed.kind ||
      !isSniffedKindAllowedInBucket(sniffed.kind, 'maintenance-photos')
    ) {
      return reject();
    }
    const photoKind = sniffed.kind as 'jpeg' | 'png' | 'webp';
    let clean = await reencodeWithoutMetadata(whole, photoKind, { maxInputPixels: MAX_INPUT_PIXELS });
    if (clean && clean.master.byteLength > MAINTENANCE_MAX_PHOTO_BYTES && photoKind !== 'png') {
      // Grown past the cap (a photo saved at a lower quality than 90): once
      // more at OVER_CAP_RETRY_QUALITY before refusing it.
      clean = await reencodeWithoutMetadata(whole, photoKind, {
        maxInputPixels: MAX_INPUT_PIXELS,
        quality: OVER_CAP_RETRY_QUALITY,
      });
    }
    if (
      !clean ||
      clean.master.byteLength === 0 ||
      clean.master.byteLength > MAINTENANCE_MAX_PHOTO_BYTES ||
      clean.contentType !== MIME_FOR_KIND[sniffed.kind] ||
      sniffImage(clean.master)?.kind !== sniffed.kind
    ) {
      return reject();
    }
    // Over the upload (the service role; the bucket has no UPDATE policy, so
    // the uploader cannot put the original back), and the thumbnail at the
    // mint's name, replacing the client's. Step 0 proved no recorded photo
    // owns either name.
    const [masterPut, thumbPut] = await Promise.all([
      store.upload(args.path, clean.master, { contentType: clean.contentType, upsert: true }),
      store.upload(thumbPath, clean.thumb, { contentType: 'image/webp', upsert: true }),
    ]);
    if (masterPut.error || thumbPut.error) {
      return refuse(new ServiceError('internal_error', 'Could not save the photo.'), false);
    }
    const width = clean.width ?? sniffed.width;
    const height = clean.height ?? sniffed.height;

    // The row is written with the SERVICE ROLE (L40), so the attachments
    // INSERT policy can later be dropped: through it a requester could insert
    // a row straight into the table, naming an upload that skipped every check
    // above. The service role skips that policy too, so this call restates
    // what it enforced:
    //   - uploaded_by = the caller: written from ctx below, never an input;
    //   - module on: assertModuleEnabled at the top of finalize;
    //   - kind allowed for the caller: validateKind ('resolution' needs
    //     maintenance_requests:manage);
    //   - request open, and the caller its requester or a manage-holder:
    //     assertParentOwnedAndOpen, run AGAIN here, just before the write,
    //     because the request may have closed while the photo was processed
    //     (the policy checked it at insert time). A refusal here cleans up
    //     the upload like every other refusal.
    try {
      await this.assertParentOwnedAndOpen(requestId);
    } catch (recheckErr) {
      if (recheckErr instanceof ServiceError) return refuse(recheckErr, false);
      throw recheckErr;
    }

    const { data: row, error } = await admin
      .from('maintenance_request_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        maintenance_request_id: requestId,
        storage_path: args.path,
        thumbnail_path: thumbPath,
        original_filename: args.originalFilename.slice(0, 300),
        safe_filename: sanitizeFilenameSegment(args.originalFilename).slice(0, 300) || 'photo',
        // The STORED (clean) file, not the upload it replaced.
        mime_type: clean.contentType,
        byte_size: clean.master.byteLength,
        width,
        height,
        uploaded_by: this.ctx.userId,
        verified_at: new Date().toISOString(),
        kind,
      })
      .select('id')
      .single();
    if (error?.code === '23505') {
      // The new (organization_id, storage_path) uniqueness guard (Important
      // 3 migration) caught a second finalize racing the SAME object — one
      // row already backs it. Do NOT remove the storage object here: it
      // still belongs to whichever insert won.
      throw new ServiceError('conflict', ALREADY_RECORDED);
    }
    if (error || !row) {
      // A failed metadata insert leaves an orphan object — roll it back
      // rather than leave storage holding a file no row will ever reference.
      // Through `refuse`, which looks first: an answer lost after the row was
      // written (or no error and no row) must not delete a recorded photo.
      return refuse(
        new ServiceError('internal_error', error?.message ?? 'Could not record the photo.'),
        false,
      );
    }

    await audit(
      {
        event: 'maintenance_request.attachment_added',
        entityType: 'maintenance_request',
        entityId: requestId,
        extra: { attachment_id: row.id, byte_size: clean.master.byteLength },
      },
      this.ctx,
    );
    return { id: row.id as string, width, height };
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
      // the read and this write). Minor 12: distinguish the closed-request
      // cause from any other RLS refusal, same message assertParentOwned
      // AndOpen uses, rather than one generic catch-all for both. M2 fix
      // wave: this read used to check only archived_at/cancelled_at, so a
      // photo removal refused because the request had been RESOLVED (0317's
      // RLS predicate also gates on resolved_at — see assertParentOwnedAnd
      // Open's own doc comment) fell through to the generic message below
      // instead of the accurate closed-request one.
      const { data: parent } = await this.ctx.supabase
        .from('maintenance_requests')
        .select('archived_at, cancelled_at, resolved_at')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', requestId)
        .maybeSingle();
      const parentRow = parent as
        | { archived_at: string | null; cancelled_at: string | null; resolved_at: string | null }
        | null;
      if (parentRow?.archived_at || parentRow?.cancelled_at || parentRow?.resolved_at) {
        throw new ServiceError('conflict', 'This request is closed; photos can no longer change.');
      }
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
      .select('id, storage_path, thumbnail_path, original_filename, width, height, kind')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const list = (rows ?? []) as Record<string, unknown>[];
    if (list.length === 0) return [];

    // Minor 11 — ONE batched createSignedUrls covering every master + thumb
    // path on this request, instead of a createSignedUrl round trip per row
    // (a request holding MAINTENANCE_MAX_PHOTOS photos was paying up to 16
    // sequential signing calls just to render its detail page).
    const admin = createAdminClient();
    const paths: string[] = [];
    for (const r of list) {
      paths.push(r.storage_path as string);
      const thumbnailPath = r.thumbnail_path as string | null;
      if (thumbnailPath) paths.push(thumbnailPath);
    }
    const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUrls(paths, VIEW_URL_TTL_SEC);
    // A whole-call failure means nothing signed at all — including every
    // master — so this throws exactly like a single-row master failure did
    // before (recurring bug #6: a caller must never be handed a `null` that
    // renders as a broken image).
    if (signErr || !signed) throw new ServiceError('internal_error', 'Could not sign photo URL');
    const byPath = new Map(signed.map((s) => [s.path, s]));

    return list.map((r) => {
      const storagePath = r.storage_path as string;
      const master = byPath.get(storagePath);
      if (!master || master.error || !master.signedUrl) {
        throw new ServiceError('internal_error', 'Could not sign photo URL');
      }
      // The thumb is a nice-to-have variant of the SAME photo, not a
      // distinct asset — unlike a failed master (which IS the photo), a
      // failed/missing thumb sign falls back to null so the caller renders
      // the master instead of losing the whole row over a secondary asset.
      let thumbUrl: string | null = null;
      const thumbnailPath = r.thumbnail_path as string | null;
      if (thumbnailPath) {
        const thumb = byPath.get(thumbnailPath);
        if (thumb && !thumb.error && thumb.signedUrl) thumbUrl = thumb.signedUrl;
      }
      return {
        id: r.id as string,
        originalFilename: r.original_filename as string,
        url: master.signedUrl,
        thumbUrl,
        width: (r.width as number | null) ?? null,
        height: (r.height as number | null) ?? null,
        kind: r.kind as MaintenanceAttachmentKind,
      };
    });
  }
}
