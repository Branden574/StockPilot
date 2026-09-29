/**
 * A report file (CSV or PDF) from an authenticated /api/v1 export route,
 * downloaded to this phone's cache and handed to the iOS share sheet (Save to
 * Files, AirDrop, Mail, Print). JS only: expo-file-system (already in the
 * binary) and React Native's own Share, so it ships by OTA.
 *
 * IMPORT PATH IS LOAD-BEARING: `expo-file-system/legacy` (see
 * signed-photo-upload.ts). The URI-string API moved there in
 * expo-file-system 19; the default export typechecks and throws at runtime.
 *
 * THE RULES IT KEEPS:
 *
 *   - The request carries the session's Bearer token AND the workspace the
 *     report is for (X-Organization-Id, named by the caller, never read back
 *     from storage), like api(). A raw download without the header would be
 *     answered for the account's default organization.
 *   - A refusal is a failure, never a file: any status but 200 reads at most
 *     4 KB of the answer as text for the route's { error, message, details },
 *     deletes the file, and throws ReportExportError with the status, code,
 *     details and Retry-After, so the screen words it like any other refusal.
 *     A 401 asks the account gate for a probe, as api() does.
 *   - It gives up after REPORT_EXPORT_TIMEOUT_MS (a stalled download is
 *     cancelled and its partial file deleted), and an account eviction
 *     cancels it (it is registered with the in-flight requests).
 *   - A file that lands after the signed-in account changed is deleted and
 *     never shared.
 *   - Only the last export stays on the phone: the export folder is emptied
 *     before each new download.
 *   - Sharing is iOS only (React Native's Share passes `url` on iOS only;
 *     Android shares `message`). On Android the screens offer the web instead,
 *     and this refuses rather than share a bare path.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';

import { accountEpoch } from './account-epoch';
import { notifyUnauthorized } from './account-eviction';
import { API_BASE } from './api';
import { bookReportExportMode } from './book-order-totals-view';
import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { registerInFlight } from './request-cancellation';
import { supabase } from './supabase';

/** A large PDF with covers is rendered on the server before a byte arrives. */
export const REPORT_EXPORT_TIMEOUT_MS = 90_000;

/** How much of a refusal is read (the route's JSON error is far smaller). */
export const REPORT_EXPORT_ERROR_BYTES = 4096;

export const REPORT_EXPORT_DIR_NAME = 'report-exports/';

export const REPORT_EXPORT_TIMED_OUT =
  'The file took too long to prepare. Narrow the filters and try again.';
export const REPORT_EXPORT_STOPPED = 'The download was stopped.';
export const REPORT_EXPORT_NO_STORAGE = 'This phone could not save the file. Try again.';
export const REPORT_EXPORT_SESSION_CHANGED =
  'You signed out or switched accounts while the file was downloading. It was not saved.';
export const REPORT_EXPORT_SHARE_UNAVAILABLE = 'Sharing a file is not available on this phone.';

/** A failed export, shaped like api()'s ApiError (status, code, details) so
 *  describeBookReportError words it; plus the server's Retry-After. */
export class ReportExportError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ReportExportError';
  }
}

export interface ReportExportRequest {
  /** The route path with its query (/api/v1/...). */
  path: string;
  /** The workspace the report is for. */
  orgId: string;
  format: 'csv' | 'pdf';
  /** Used when the server names no file. */
  fallbackName: string;
}

function header(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return null;
}

/** A file name from Content-Disposition, reduced to [A-Za-z0-9._-] and forced
 *  to the export's extension; the fallback when there is none. */
export function exportFileName(
  contentDisposition: string | null,
  format: 'csv' | 'pdf',
  fallback: string,
): string {
  const m = contentDisposition ? /filename="?([^";]+)"?/i.exec(contentDisposition) : null;
  const raw = (m?.[1] ?? fallback).trim();
  const base = raw
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return `${base || 'report'}.${format}`;
}

/** Seconds from a Retry-After header (a number of seconds), or null. */
export function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The route's { error, message, details } from a refusal's first bytes. */
export function parseExportRefusal(
  status: number,
  body: string,
  retryAfter: number | null,
): ReportExportError {
  let message: string | null = null;
  let code: string | undefined;
  let details: unknown;
  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; details?: unknown };
      message = typeof parsed.message === 'string' ? parsed.message : null;
      code = typeof parsed.error === 'string' ? parsed.error : undefined;
      details = parsed.details;
    } catch {
      message = null;
    }
  }
  return new ReportExportError(
    message ?? `The export was refused (${status}).`,
    status,
    code,
    details,
    retryAfter,
  );
}

async function bearer(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function removeQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* a leftover cache file is not worth failing over */
  }
}

/**
 * Download one export to the phone's cache. Resolves with the file's URI and
 * name; throws ReportExportError on any refusal or failure (the partial file
 * is deleted first).
 */
export async function downloadReportFile(
  req: ReportExportRequest,
  opts: { timeoutMs?: number } = {},
): Promise<{ uri: string; filename: string }> {
  const cache = FileSystem.cacheDirectory;
  if (!cache) throw new ReportExportError(REPORT_EXPORT_NO_STORAGE, null);
  const dir = `${cache}${REPORT_EXPORT_DIR_NAME}`;
  // Only the last export stays on the phone.
  await removeQuietly(dir);
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    throw new ReportExportError(REPORT_EXPORT_NO_STORAGE, null);
  }

  const token = await bearer();
  if (!token) {
    throw new ReportExportError('Your session has ended. Sign in again.', 401, 'unauthenticated');
  }
  const epoch = accountEpoch();
  const temp = `${dir}download-${Date.now()}.${req.format}`;
  const task = FileSystem.createDownloadResumable(`${API_BASE}${req.path}`, temp, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Organization-Id': req.orgId,
    },
  });

  // An eviction aborts every registered controller; our own timeout does too.
  const ctrl = new AbortController();
  const release = registerInFlight(ctrl);
  let timedOut = false;
  const onAbort = () => {
    void task.cancelAsync().catch(() => undefined);
  };
  ctrl.signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? REPORT_EXPORT_TIMEOUT_MS);

  let result: Awaited<ReturnType<typeof task.downloadAsync>>;
  try {
    result = await task.downloadAsync();
  } catch {
    await removeQuietly(temp);
    if (timedOut) throw new ReportExportError(REPORT_EXPORT_TIMED_OUT, null);
    if (ctrl.signal.aborted) throw new ReportExportError(REPORT_EXPORT_STOPPED, null);
    // No answer at all: the connection (the network layer's own text is
    // never shown).
    throw new ReportExportError(CONNECTION_FAILURE_COPY, null);
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener('abort', onAbort);
    release();
  }

  if (!result || timedOut || ctrl.signal.aborted) {
    await removeQuietly(temp);
    throw new ReportExportError(timedOut ? REPORT_EXPORT_TIMED_OUT : REPORT_EXPORT_STOPPED, null);
  }
  if (accountEpoch() !== epoch) {
    await removeQuietly(temp);
    throw new ReportExportError(REPORT_EXPORT_SESSION_CHANGED, null);
  }
  if (result.status !== 200) {
    let body = '';
    try {
      body = await FileSystem.readAsStringAsync(temp, {
        position: 0,
        length: REPORT_EXPORT_ERROR_BYTES,
      });
    } catch {
      body = '';
    }
    await removeQuietly(temp);
    notifyUnauthorized({ status: result.status });
    throw parseExportRefusal(
      result.status,
      body,
      retryAfterSeconds(header(result.headers, 'retry-after')),
    );
  }

  const filename = exportFileName(
    header(result.headers, 'content-disposition'),
    req.format,
    req.fallbackName,
  );
  const target = `${dir}${filename}`;
  if (target === temp) return { uri: temp, filename };
  try {
    await FileSystem.moveAsync({ from: temp, to: target });
    return { uri: target, filename };
  } catch {
    // The download is good; only its name could not be changed.
    return { uri: temp, filename };
  }
}

/**
 * Open the share sheet for a downloaded file (iOS). Resolves when the sheet
 * closes. Refuses on any other platform: Android's Share would send the
 * path as text, not the file.
 */
export async function shareReportFile(uri: string, title: string): Promise<void> {
  if (bookReportExportMode(Platform.OS) !== 'share') {
    throw new ReportExportError(REPORT_EXPORT_SHARE_UNAVAILABLE, null);
  }
  await Share.share({ url: uri, title });
}

/** Download, then share. The whole export flow a screen calls. */
export async function exportAndShareReport(
  req: ReportExportRequest & { title: string },
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (bookReportExportMode(Platform.OS) !== 'share') {
    throw new ReportExportError(REPORT_EXPORT_SHARE_UNAVAILABLE, null);
  }
  const file = await downloadReportFile(req, opts);
  await shareReportFile(file.uri, req.title);
}
