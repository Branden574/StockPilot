import type { InventoryExportOptions } from '@/lib/exports/export-request';
import {
  EXPORT_FORBIDDEN_COPY,
  EXPORT_SESSION_ENDED_COPY,
  ExportRefusedError,
} from '@/lib/exports/export-refusal';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

/**
 * Client-side trigger for the unified inventory export
 * (`POST /api/inventory/export`) and its preview sibling. POSTs the request (so
 * a large "export selected" id list isn't capped by URL length), reads the
 * returned file as a blob, and saves it using the server's Content-Disposition
 * filename. Throws with a readable message on failure so callers can toast it.
 */
export interface InventoryExportRequest {
  format: 'csv' | 'xlsx' | 'pdf';
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: {
    q?: string;
    status?: 'active' | 'archived' | 'discontinued' | 'all';
    stock?: 'low' | 'out' | null;
    /** True when exporting the Expected chip view (?expected=1, mig 0277)
     *  — export ONLY items awaiting their first receipt. */
    expected?: boolean;
    sort?: string;
    categoryIds?: string[];
    locationIds?: string[];
    charterIds?: string[];
  };
  /** Registry field keys, in the order they should appear. Omit for defaults. */
  fields?: string[];
  options?: Partial<InventoryExportOptions>;
}

/**
 * Stages the CLIENT can actually observe.
 *
 * Deliberately only two working states. The brief sketches four ("Preparing… /
 * Loading cover images… / Building PDF… / Downloading…"), but the server does
 * all of that inside one request with no progress channel, so announcing
 * "Loading cover images" would be a guess dressed as a fact — and the same
 * section forbids fake progress. The dialog adds a static note when images are
 * enabled ("Cover images make this slower"), which is true without pretending
 * to know where the server is.
 */
export type ExportStage = 'preparing' | 'downloading' | 'done';

export interface DownloadExportOptions {
  onStage?: (stage: ExportStage) => void;
  signal?: AbortSignal;
}

/**
 * The error a failed answer throws, by what the server answered (B68).
 *
 * A 403 `forbidden` (no items:export) and a 401 (the session ended) are
 * ExportRefusedError: trying again cannot fix them, so the dialog says why and
 * offers no Try again. The 403 is keyed on its code too, because the export
 * limiter's cross_site_request is also a 403 and is not about permission. The
 * server's own sentence is used when it sent one; its code (`error`) is never
 * the text, so no one reads "forbidden" or "unauthenticated" again.
 */
async function errorFromResponse(res: Response): Promise<Error> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body: no words from the server */
  }
  const { error: code, message } =
    body !== null && typeof body === 'object'
      ? (body as { error?: unknown; message?: unknown })
      : {};
  const words = typeof message === 'string' && message.trim() !== '' ? message : null;
  if (res.status === 403 && code === 'forbidden') {
    return new ExportRefusedError(words ?? EXPORT_FORBIDDEN_COPY);
  }
  if (res.status === 401) return new ExportRefusedError(EXPORT_SESSION_ENDED_COPY);
  return new Error(words ?? 'Export failed. Please try again.');
}

export async function downloadInventoryExport(
  req: InventoryExportRequest,
  opts: DownloadExportOptions = {},
): Promise<void> {
  opts.onStage?.('preparing');
  const res = await fetch('/api/inventory/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  opts.onStage?.('downloading');
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] ?? `inventory-export.${req.format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  opts.onStage?.('done');
}

export interface ExportPreviewRequest {
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: InventoryExportRequest['filters'];
}

export interface ExportPreviewResponse {
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
  /** At most 10 rows. `image` is always null — a preview signs nothing. */
  sampleRows: InventoryExportSourceRow[];
  readiness: {
    rows: number;
    withIsbn: number;
    missingIsbn: number;
    /** null when the image check failed (the dialog says it is unavailable). */
    withImage: number | null;
    missingImage: number | null;
  };
}

export async function fetchExportPreview(
  req: ExportPreviewRequest,
  signal?: AbortSignal,
): Promise<ExportPreviewResponse> {
  const res = await fetch('/api/inventory/export/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as ExportPreviewResponse;
}
