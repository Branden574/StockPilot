/**
 * PUT a body to a presigned URL while reporting real upload progress.
 *
 * WHY THIS EXISTS — `fetch()` cannot do it
 * ----------------------------------------------------------------------
 * `fetch()` exposes no upload-progress signal. Its request body is not
 * observable while it drains: there is no `upload` object, no progress event,
 * and `ReadableStream` request bodies (which could in principle be counted as
 * they are pulled) are not usable here because Supabase Storage needs a
 * known Content-Length and duplex streaming request bodies are not broadly
 * supported. `XMLHttpRequest` is the only browser API that reports how many
 * bytes of a request body have actually gone out, via `upload.onprogress`.
 *
 * So this is deliberately XHR and not a stylistic throwback. If someone later
 * "modernises" it to `fetch()`, the percentage silently becomes a lie.
 *
 * HONESTY RULES ENCODED HERE
 *   * `onProgress` only ever reports bytes the transport says were sent. It is
 *     never synthesised from a timer, and never optimistically set to 1.
 *   * A request that fails does NOT report completion. The caller keeps
 *     whatever fraction was genuinely reached, so a failed upload can never
 *     render as 100%.
 *   * `lengthComputable` is honoured: if the browser cannot say how big the
 *     body is, no fraction is reported at all rather than a fabricated one.
 */

export interface UploadProgress {
  /** Bytes confirmed sent by the transport. */
  loaded: number;
  /** Total bytes for this request, per the transport. */
  total: number;
}

export interface UploadWithProgressOptions {
  url: string;
  body: Blob;
  contentType: string;
  /** Extra request headers. Supabase Storage needs `x-upsert` on re-uploads. */
  headers?: Record<string, string>;
  /** Called as bytes leave. Never called with a fabricated value. */
  onProgress?: (progress: UploadProgress) => void;
  /** Abort support, so a caller can cancel a batch. */
  signal?: AbortSignal;
}

export interface UploadResult {
  ok: boolean;
  status: number;
}

export function uploadWithProgress({
  url,
  body,
  contentType,
  headers = {},
  onProgress,
  signal,
}: UploadWithProgressOptions): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        // Without lengthComputable there is no honest fraction to report.
        if (!event.lengthComputable) return;
        onProgress({ loaded: event.loaded, total: event.total });
      };
    }

    // A non-2xx is a RESOLVED promise with ok:false, mirroring fetch()'s
    // contract so call sites keep their existing `if (!res.ok)` handling.
    // Only a transport-level failure rejects.
    xhr.onload = () => {
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(body);
  });
}

/**
 * Byte-weighted progress across a batch of files.
 *
 * Weighted by each file's ORIGINAL size, captured before any work starts, for
 * one reason: the denominator must never move. Compression is per-file and
 * interleaves with uploading, so a denominator built from COMPRESSED sizes
 * would grow as each file finished compressing — and a percentage whose
 * denominator grows can travel backwards, which reads as a broken bar.
 *
 * Each file contributes `fraction_i * originalSize_i`, so the reported total is
 * monotonic and reaches 1 only when every tracked file has genuinely finished.
 * Files that never start (rejected by validation) are excluded from the
 * denominator by the caller rather than stranding the bar below 100%.
 */
export class BatchProgress {
  private readonly weights = new Map<string, number>();
  private readonly fractions = new Map<string, number>();
  private readonly totalWeight: number;

  constructor(entries: Array<{ key: string; weight: number }>) {
    for (const { key, weight } of entries) {
      // Guard against a zero-byte file making the weight meaningless.
      this.weights.set(key, Math.max(1, weight));
    }
    this.totalWeight = Array.from(this.weights.values()).reduce((a, b) => a + b, 0);
  }

  /** Record a file's own completion fraction (0..1), clamped and monotonic. */
  set(key: string, fraction: number): void {
    if (!this.weights.has(key)) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    const previous = this.fractions.get(key) ?? 0;
    // Monotonic per file: a retry restarting at 0 must not rewind the bar.
    this.fractions.set(key, Math.max(previous, clamped));
  }

  /**
   * Settle a file that will send no more bytes — success or failure. On
   * FAILURE the caller passes `succeeded: false`, which leaves that file's
   * fraction where it stopped, so the batch can never read 100% when
   * something failed. Only a success claims the file's full weight.
   */
  settle(key: string, succeeded: boolean): void {
    if (!this.weights.has(key)) return;
    if (succeeded) this.fractions.set(key, 1);
  }

  /** Overall fraction 0..1. Returns 0 when nothing is tracked. */
  get fraction(): number {
    if (this.totalWeight <= 0) return 0;
    let done = 0;
    for (const [key, weight] of this.weights) {
      done += (this.fractions.get(key) ?? 0) * weight;
    }
    return Math.max(0, Math.min(1, done / this.totalWeight));
  }

  /** Whole-number percent, floored so it never shows 100 before completion. */
  get percent(): number {
    const raw = this.fraction * 100;
    // Floor, then hold 99 until genuinely complete: rounding 99.6 up to 100
    // while bytes are still moving is exactly the lie this class avoids.
    if (raw >= 100) return 100;
    return Math.min(99, Math.floor(raw));
  }
}
