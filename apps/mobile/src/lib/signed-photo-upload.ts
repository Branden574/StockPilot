/**
 * ONE photo through a signed upload: resize/transcode -> mint -> native PUT
 * (+ an optional best-effort thumbnail PUT) -> finalize. The steps and their
 * failure kinds are shared; WHERE each step goes is the caller's
 * (`SignedPhotoEndpoints`): maintenance requests (maintenance-upload.ts) and
 * exception evidence (exception-evidence.ts) each supply their own mint,
 * finalize and error mapping.
 *
 * Extracted from maintenance-upload.ts (F1-4) without changing a step: every
 * maintenance-upload test runs against `uploadMaintenancePhoto`, which is now
 * a thin wrapper over this.
 *
 * WHY THE PUT IS NATIVE. The documented RN landmine is that
 * `fetch(uri).blob()` on Expo silently uploads a 0-byte object (see
 * item-create.ts's `uploadPhotosFor`, which works around it with
 * `fetch(uri).arrayBuffer()`). `expo-file-system`'s native `createUploadTask`
 * reads the file straight off disk and never builds a JS Blob, and it is the
 * only route that reports live upload progress.
 *
 * IMPORT PATH IS LOAD-BEARING: `expo-file-system/legacy`, not
 * `expo-file-system`. expo-file-system 19+ moved the URI-string API to the
 * `/legacy` subpath; `createUploadTask` / `uploadAsync` are still typed on the
 * default export but THROW at runtime there, so a plain import typechecks and
 * then fails on the first upload.
 *
 * `uploadSignedPhoto` is stateless: calling it again for the same asset (a
 * Retry tap) is a complete, independent attempt. `createPhotoAttemptGuard` is
 * what a SCREEN uses to decide whether an in-flight attempt's progress or
 * result is still the one it should apply.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { resizeForUpload } from './image-resize';

/**
 * Typed upload failure so a screen can render accurate, per-kind copy
 * instead of one generic "something went wrong" (never claim an upload
 * succeeded when it didn't, and never blur a network problem with a server
 * refusal: they call for different user actions):
 *
 *   - 'upload_failed': the PUT itself failed (network drop, expired signed
 *     URL, timeout). The server never received the bytes, so there is no
 *     row and no cleanup needed: just retry.
 *   - 'rejected': the server SAW the object and refused to record it. A
 *     different photo, or a different moment, may work; "retry the same
 *     bytes" may not.
 *   - 'rate_limited': the mint step's own rate limiter tripped. The fix is
 *     "wait a bit", not "pick a different photo".
 */
export class UploadError extends Error {
  constructor(
    public kind: 'upload_failed' | 'rejected' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The sentence for a failed PUT (the server never saw the bytes). */
export const PHOTO_PUT_FAILED_COPY = 'Photo upload failed. Check your connection and retry.';

/**
 * Extension -> the three MIME types the finalize steps' magic-byte sniffs
 * recognise (image-signature.ts: png/jpeg/webp).
 *
 * `resizeForUpload` does NOT always force JPEG: an already-small source that
 * is already web-safe (a PNG screenshot, a WEBP image) comes back UNCHANGED,
 * ext included (image-resize.ts). Hardcoding 'jpg'/'image/jpeg' would declare
 * the wrong type for a real PNG/WEBP, and finalize's sniffed-bytes-vs-declared
 * check would refuse every one of them.
 */
const DECLARED_MIME_FOR_EXT: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** One photo, resized and ready to PUT. */
export interface PreparedPhoto {
  /** The file to PUT (the resized one, never the picker's original). */
  uri: string;
  /** 'jpg' (never 'jpeg'), 'png', 'webp', or whatever else resizeForUpload
   *  kept when the endpoints do not restrict the extensions. */
  ext: string;
  declaredMime: 'image/jpeg' | 'image/png' | 'image/webp';
  /** The picker's name with the uploaded extension, or "photo.<ext>". */
  originalFilename: string;
}

/** What every mint must answer: where to PUT the bytes. */
export interface SignedUploadTicket {
  signedUrl: string;
}

/**
 * Where one kind of photo goes. `mint` and `finalize` are the only required
 * steps. Each error mapper returns what is THROWN in place of the raw error
 * (return the error itself to pass it through); without a mapper the raw
 * error propagates.
 */
export interface SignedPhotoEndpoints<T extends SignedUploadTicket, R> {
  mint(photo: PreparedPhoto): Promise<T>;
  finalize(ticket: T, photo: PreparedPhoto): Promise<R>;
  /** A signed URL for a client-made thumbnail, when the server wants one.
   *  Absent (or null) when the server makes its own: no thumbnail is made or
   *  sent then. */
  thumbUploadUrl?(ticket: T): string | null | undefined;
  mapMintError?(e: unknown): unknown;
  mapFinalizeError?(e: unknown, ticket: T, photo: PreparedPhoto): unknown;
  /** Called once the bytes are on the server, before finalize: the ticket
   *  the photo can be finalized with again if finalize's answer is lost. */
  onUploaded?(ticket: T, photo: PreparedPhoto): void;
  /** The extensions the endpoint accepts. A resized file of any other kind
   *  (a small GIF kept as-is by resizeForUpload) is transcoded to JPEG
   *  before the mint. Absent: whatever resizeForUpload returned is sent. */
  acceptedExtensions?: readonly string[];
}

/** Resize/transcode one picked asset (step 1 of every upload). */
export async function preparePhoto(
  asset: { uri: string; fileName?: string },
  acceptedExtensions?: readonly string[],
): Promise<PreparedPhoto> {
  // HEIC never reaches the server: resizeForUpload either downsizes to JPEG
  // (anything over 1600px on its long edge) or, for an already-small source,
  // transcodes any non-web-safe format (HEIC/HEIF) to JPEG too.
  const resized = await resizeForUpload(asset.uri);
  let uri = resized.uri;
  let ext = resized.ext === 'jpeg' ? 'jpg' : resized.ext;
  if (acceptedExtensions && !acceptedExtensions.includes(ext)) {
    const converted = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 0.85,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    uri = converted.uri;
    ext = 'jpg';
  }
  const declaredMime = DECLARED_MIME_FOR_EXT[ext] ?? 'image/jpeg';
  const name = asset.fileName?.replace(/\.[a-z0-9]+$/i, '') || 'photo';
  return { uri, ext, declaredMime, originalFilename: `${name}.${ext}` };
}

/**
 * The PUT (step 3), shared so a caller can re-send bytes it already prepared.
 * Throws UploadError('upload_failed') on any non-2xx answer.
 */
export async function putSignedPhoto(
  signedUrl: string,
  photo: Pick<PreparedPhoto, 'uri' | 'declaredMime'>,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const task = FileSystem.createUploadTask(
    signedUrl,
    photo.uri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': photo.declaredMime },
    },
    (progress) => {
      if (progress.totalBytesExpectedToSend > 0) {
        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
      }
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    // The server never saw these bytes: finalize must NEVER be called past
    // this point (it would only fail its own download step).
    throw new UploadError('upload_failed', PHOTO_PUT_FAILED_COPY);
  }
}

export async function uploadSignedPhoto<T extends SignedUploadTicket, R>(
  endpoints: SignedPhotoEndpoints<T, R>,
  asset: { uri: string; fileName?: string },
  onProgress: (fraction: number) => void,
): Promise<R> {
  // 1) Resize + transcode.
  const photo = await preparePhoto(asset, endpoints.acceptedExtensions);

  // 2) Server mint (rate-limited, entity-checked).
  const ticket = await endpoints.mint(photo).catch((err: unknown) => {
    throw endpoints.mapMintError ? endpoints.mapMintError(err) : err;
  });

  // 3) PUT via createUploadTask: the OTA-safe, progress-reporting route.
  await putSignedPhoto(ticket.signedUrl, photo, onProgress);
  endpoints.onUploaded?.(ticket, photo);

  // 4) Thumb (best-effort, only where the server wants a client-made one):
  // 400px JPEG via ImageManipulator, PUT without progress. A failed thumb
  // never fails the upload: the master IS the photo.
  const thumbUrl = endpoints.thumbUploadUrl?.(ticket);
  if (thumbUrl) {
    try {
      const thumb = await ImageManipulator.manipulateAsync(photo.uri, [{ resize: { width: 400 } }], {
        compress: 0.8,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      await FileSystem.uploadAsync(thumbUrl, thumb.uri, {
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    } catch {
      // Deliberately swallowed: see above.
    }
  }

  // 5) Finalize: the server checks the bytes before it records a row, so a
  // failure here is a refusal (or a lost answer), not a dropped PUT.
  return await endpoints.finalize(ticket, photo).catch((err: unknown) => {
    throw endpoints.mapFinalizeError ? endpoints.mapFinalizeError(err, ticket, photo) : err;
  });
}

/**
 * Per-photo generalization of `createSequenceGuard` (debounced-list-load.ts):
 * ONE independent attempt counter per photo key. A screen calls `start(key)`
 * right before an upload (the first add AND every Retry tap) and gates every
 * progress/success/failure report through `isCurrent` before applying it.
 *
 * Why a photo needs its OWN guard: a Retry starts a SECOND upload for the same
 * photo while the first may still be in flight. If the FIRST attempt's
 * failure lands AFTER the retry succeeded, applying it would flip a 'done'
 * row back to 'error' for bytes that were saved. A stale SUCCESS landing after
 * a genuine retry failure is worse: it would claim an upload succeeded when
 * it didn't.
 */
export interface PhotoAttemptGuard {
  /** Starts a new attempt for `key`, invalidating whatever attempt was
   *  previously in flight for that key. Returns the token this call owns. */
  start(key: string): number;
  /** True when `token` is still the CURRENT attempt for `key`. */
  isCurrent(key: string, token: number): boolean;
}

export function createPhotoAttemptGuard(): PhotoAttemptGuard {
  const tokens = new Map<string, number>();
  return {
    start(key) {
      const next = (tokens.get(key) ?? 0) + 1;
      tokens.set(key, next);
      return next;
    },
    isCurrent(key, token) {
      return tokens.get(key) === token;
    },
  };
}
