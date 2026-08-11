/**
 * Direct-to-Storage upload with HONEST progress for RLS-gated buckets
 * (po-attachments, order-attachments). Replaces the old
 * `fetch('file://…').arrayBuffer()` + `supabase.storage.upload()` pair at
 * both call sites, which (a) buffered the whole file into JS memory, (b) sat
 * on the SDK-57 expo/fetch risk list for `fetch('file://')`, and (c) could
 * report no upload progress at all — a plain `supabase-js` `.upload()` call
 * cannot (same reasoning as maintenance-upload.ts, which pioneered this
 * route).
 *
 * Sequence: mint a signed upload URL with the user's own RLS-scoped Supabase
 * client (storage enforces the SAME insert policy at mint time that it
 * enforced on the old direct `.upload()`), then PUT the file with
 * `expo-file-system`'s native `createUploadTask`, which streams straight off
 * disk — no JS Blob, no arrayBuffer — and reports live transported bytes.
 *
 * ⚠️ IMPORT PATH IS LOAD-BEARING: `expo-file-system/legacy`, not
 * `expo-file-system` — SDK 54 moved the URI-string API (createUploadTask /
 * uploadAsync / getInfoAsync) to the `/legacy` subpath; the bare import
 * typechecks and then THROWS at runtime (see maintenance-upload.ts).
 *
 * Progress honesty (binding, mirrors web's lib/upload-with-progress):
 *   * `onProgress` only ever reports bytes the transport says were sent —
 *     never synthesised from a timer, never optimistically set to 1.
 *   * No known total (`totalBytesExpectedToSend <= 0`) → no fraction at all,
 *     rather than a fabricated one.
 *   * A failed upload NEVER reports completion: nothing here emits 1 on its
 *     own — completion is the caller observing `{ ok: true }`.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { supabase } from './supabase';

export type StorageUploadResult = { ok: true } | { ok: false; error: string };

export async function uploadFileToBucket(args: {
  bucket: string;
  /** Full storage object path — callers keep their existing path schemes. */
  path: string;
  /** Local file uri (file://…) — streamed natively, never read into JS. */
  fileUri: string;
  contentType: string;
  /** Transported fraction 0..1. Only ever called with transport-truthful
   *  values; never called after a failure to claim completion. */
  onProgress?: (fraction: number) => void;
}): Promise<StorageUploadResult> {
  // Mint with the RLS-scoped client: storage checks the bucket's insert
  // policy HERE, so a viewer who couldn't `.upload()` before can't mint a
  // signed URL now — the permission gate is unchanged, only the transport is.
  const { data: mint, error: mintErr } = await supabase.storage
    .from(args.bucket)
    .createSignedUploadUrl(args.path);
  if (mintErr || !mint?.signedUrl) {
    return { ok: false, error: mintErr?.message ?? 'Could not authorize the upload.' };
  }

  const task = FileSystem.createUploadTask(
    mint.signedUrl,
    args.fileUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': args.contentType },
    },
    (progress) => {
      // Without a known total there is no honest fraction to report.
      if (progress.totalBytesExpectedToSend > 0) {
        args.onProgress?.(
          Math.max(0, Math.min(1, progress.totalBytesSent / progress.totalBytesExpectedToSend)),
        );
      }
    },
  );

  let result: { status: number } | null | undefined;
  try {
    result = await task.uploadAsync();
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Upload failed. Check your connection and retry.',
    };
  }
  if (!result || result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      error: `Upload failed (HTTP ${result ? result.status : 'no response'}). Check your connection and retry.`,
    };
  }
  return { ok: true };
}

/**
 * Byte size of a local file, or null when the platform can't say. Exists
 * because the old arrayBuffer route got `byteLength` for free (the
 * po_attachments row records size_bytes) and the streaming route never holds
 * the bytes — the size now comes from the filesystem instead.
 */
export async function fileSizeOf(uri: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Count-weighted progress across a batch of files — the mobile sibling of
 * web's byte-weighted `BatchProgress` (lib/upload-with-progress.ts), carrying
 * the same honesty rules:
 *
 *   * per-file fractions are clamped and MONOTONIC (a retry restarting at 0
 *     must not rewind the bar);
 *   * only a SUCCESSFUL settle claims a file's full weight — a failed file
 *     keeps the fraction it genuinely reached, so the batch can never read
 *     100% when something failed;
 *   * whole percent is floored and HELD AT 99 until every file genuinely
 *     succeeded (rounding 99.6 up to 100 mid-flight is exactly the lie this
 *     exists to avoid).
 *
 * Equal weights (not byte weights) because these batches are same-shaped
 * resized photos and the file sizes aren't known before the native upload
 * starts — a fixed count denominator keeps the number monotonic, which is
 * the property that matters.
 */
export class UploadBatchProgress {
  private readonly fractions = new Map<string, number>();

  constructor(keys: string[]) {
    for (const key of keys) this.fractions.set(key, 0);
  }

  /** Record a file's own completion fraction (0..1), clamped and monotonic. */
  report(key: string, fraction: number): void {
    if (!this.fractions.has(key)) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    this.fractions.set(key, Math.max(this.fractions.get(key) ?? 0, clamped));
  }

  /** Settle a file that will send no more bytes. Only a success claims 1. */
  settle(key: string, succeeded: boolean): void {
    if (!this.fractions.has(key)) return;
    if (succeeded) this.fractions.set(key, 1);
  }

  /** Overall fraction 0..1; 0 when nothing is tracked. */
  get fraction(): number {
    if (this.fractions.size === 0) return 0;
    let sum = 0;
    for (const f of this.fractions.values()) sum += f;
    return Math.max(0, Math.min(1, sum / this.fractions.size));
  }

  /** Whole percent, floored, held at 99 until genuinely complete. */
  get percent(): number {
    const raw = this.fraction * 100;
    if (raw >= 100) return 100;
    return Math.min(99, Math.floor(raw));
  }
}
