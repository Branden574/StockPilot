import * as FileSystem from 'expo-file-system/legacy';

import { resizeForUpload } from './image-resize';

/**
 * Native document-scanner capture → PDF assembly for PO attachments.
 *
 * BOTH new native modules here bind at import time and therefore must NEVER
 * be imported at this file's top level — any binary built before they were
 * added (runtime < 1.1.0) would crash the moment this file loads (it is
 * reachable from the PO screen via po-attachments.tsx):
 *  - react-native-document-scanner-plugin (iOS VisionKit's
 *    VNDocumentCameraViewController, i.e. the Apple Notes scanner; Android
 *    ML Kit) calls TurboModuleRegistry.getEnforcing() in its JS entry.
 *  - expo-print calls requireNativeModule('ExpoPrint') in its JS entry.
 * Both are imported lazily inside the functions that use them, so even a
 * mis-targeted OTA bundle degrades to a friendly alert instead of a crash.
 * (expo-file-system predates 1.1.0 in this app, so its static import is safe.)
 * Keep it that way.
 *
 * ⚠️ `expo-file-system/legacy`, not `expo-file-system` — expo-file-system 19
 * (Expo SDK 54) moved the URI-string API (`readAsStringAsync`, `getInfoAsync`,
 * `EncodingType`) to the /legacy subpath; the same names on the default export
 * are typed but THROW at runtime. See maintenance-upload.ts for the full note.
 */

export type ScanPagesResult =
  | { status: 'success'; pages: string[] }
  | { status: 'cancelled' }
  /** Native module missing (old binary) or the scanner failed to open. */
  | { status: 'unavailable' };

/**
 * Open the native document scanner and return the captured page image URIs.
 * 'cancelled' when the user closes the camera without finishing a scan.
 */
export async function scanDocumentPages(): Promise<ScanPagesResult> {
  let mod: typeof import('react-native-document-scanner-plugin');
  try {
    // Lazy import — see the module comment above. This is the load-bearing
    // guard that keeps old binaries (no native scanner module) from crashing.
    mod = await import('react-native-document-scanner-plugin');
  } catch {
    return { status: 'unavailable' };
  }
  try {
    const { scannedImages, status } = await mod.default.scanDocument({
      responseType: mod.ResponseType.ImageFilePath,
      // Android-only page cap (ML Kit); iOS VisionKit ignores it.
      maxNumDocuments: 10,
    });
    if (status === mod.ScanDocumentResponseStatus.Cancel) return { status: 'cancelled' };
    const pages = scannedImages ?? [];
    if (pages.length === 0) return { status: 'cancelled' };
    return { status: 'success', pages };
  } catch {
    // The module loaded but the scan call itself blew up (e.g. no camera on
    // a Mac "Designed for iPad" run). Same friendly degradation.
    return { status: 'unavailable' };
  }
}

/** How a completed scan should be uploaded. Pure — unit-tested. */
export type ScanUploadPlan =
  | { kind: 'image'; uri: string } // 1 page → plain image attachment (same as Take Photo)
  | { kind: 'pdf'; uris: string[] }; // 2+ pages → one multi-page PDF

export function routeScannedPages(pages: string[]): ScanUploadPlan | null {
  if (pages.length === 0) return null;
  if (pages.length === 1) return { kind: 'image', uri: pages[0] };
  return { kind: 'pdf', uris: pages };
}

/** `scan-YYYYMMDD-HHmm.{ext}` (local time) — e.g. scan-20260706-1432.pdf */
export function scanFileName(ext: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `scan-${stamp}.${ext}`;
}

/**
 * Headroom under the po-attachments bucket's 15 MB file_size_limit (mig 0211,
 * mirrored as MAX_BYTES in po-attachments.tsx) so a valid PDF never bounces
 * off the server-side cap.
 */
const PDF_MAX_BYTES = 14 * 1024 * 1024;

export class PdfTooLargeError extends Error {
  readonly code = 'PDF_TOO_LARGE' as const;
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`Assembled PDF is ${bytes} bytes — over the ${maxBytes}-byte cap`);
    this.name = 'PdfTooLargeError';
  }
}

interface RenderQuality {
  maxEdge: number;
  quality: number;
}

/**
 * Assemble scanned page images into a single PDF (one page per sheet,
 * fit-to-page, no margins). Pages are resized/re-encoded first so a 10-page
 * scan doesn't produce a 40 MB file. If the first render exceeds the cap,
 * re-render ONCE at a lower quality; if it is still over, throw
 * PdfTooLargeError (the UI tells the user to scan fewer pages).
 */
export async function assemblePdf(
  pageUris: string[],
  opts: { maxBytes?: number } = {},
): Promise<{ uri: string; bytes: number }> {
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES;
  const first = await renderPdf(pageUris, { maxEdge: 2000, quality: 0.8 });
  if (first.bytes <= maxBytes) return first;
  const retry = await renderPdf(pageUris, { maxEdge: 1600, quality: 0.6 });
  if (retry.bytes <= maxBytes) return retry;
  throw new PdfTooLargeError(retry.bytes, maxBytes);
}

async function renderPdf(
  pageUris: string[],
  { maxEdge, quality }: RenderQuality,
): Promise<{ uri: string; bytes: number }> {
  const dataUris: string[] = [];
  for (const pageUri of pageUris) {
    const resized = await resizeForUpload(pageUri, { maxEdge, quality });
    const base64 = await FileSystem.readAsStringAsync(resized.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    dataUris.push(`data:${mimeForImageExt(resized.ext)};base64,${base64}`);
  }
  // Lazy — expo-print is a native module new in 1.1.0 (see module comment).
  const Print = await import('expo-print');
  const { uri } = await Print.printToFileAsync({ html: pagesHtml(dataUris) });
  // No `{ size: true }` opt-in any more: expo-file-system 19 dropped `size`
  // from legacy `InfoOptions` (only `md5` remains) because the native handler
  // always populates it and `FileInfo.size` became non-optional.
  const info = await FileSystem.getInfoAsync(uri);
  // If sizing fails, report 0 — the caller falls back to the upload buffer's
  // byteLength for the metadata row, and the bucket cap still enforces 15 MB.
  return { uri, bytes: info.exists ? info.size : 0 };
}

function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

/** One <img> per sheet, centered, fit-to-page, zero margins. */
function pagesHtml(dataUris: string[]): string {
  const pages = dataUris
    .map((src) => `<div class="page"><img src="${src}" /></div>`)
    .join('');
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8" /><style>' +
    '@page { margin: 0; }' +
    'html, body { margin: 0; padding: 0; }' +
    '.page { page-break-after: always; width: 100vw; height: 100vh; ' +
    'display: flex; align-items: center; justify-content: center; overflow: hidden; }' +
    // No break after the final sheet — avoids a trailing blank PDF page.
    '.page:last-child { page-break-after: auto; }' +
    'img { max-width: 100%; max-height: 100%; object-fit: contain; }' +
    `</style></head><body>${pages}</body></html>`
  );
}
