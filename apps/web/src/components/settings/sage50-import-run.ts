import type { Sage50ImportSummary } from '@/server/actions/sage50-import';

/**
 * The record a Sage 50 import keeps in this tab (lib/interrupted-run) after
 * each chunk: what has landed so far. When the session ends partway through,
 * the next chunk is answered with a redirect to sign-in and the page unloads
 * with the running summary. On every other failure the wizard shows what
 * landed, so after signing in it shows this record instead.
 */
export const SAGE50_IMPORT_RUN = 'sage50-import';

/** The most errors a summary carries (the import action keeps the first 50). */
const MAX_ERRORS = 50;

export interface StoppedImport {
  summary: Sage50ImportSummary;
  /** Items sent in the chunks that finished. */
  processed: number;
  /** Items in the loaded list. */
  fileTotal: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A stored record, checked field by field: null for any other shape. */
export function parseStoppedImport(payload: unknown): StoppedImport | null {
  if (!isRecord(payload)) return null;
  const { summary, processed, fileTotal } = payload;
  if (!isCount(processed) || !isCount(fileTotal) || !isRecord(summary)) return null;
  const { items, suppliers } = summary;
  if (!isRecord(items) || !isRecord(suppliers)) return null;

  const { total, created, failed, errors } = items;
  if (!isCount(total) || !isCount(created) || !isCount(failed) || !Array.isArray(errors)) {
    return null;
  }
  const rows: Sage50ImportSummary['items']['errors'] = [];
  for (const e of errors.slice(0, MAX_ERRORS)) {
    if (!isRecord(e)) return null;
    const { row, sku, message } = e;
    if (!isCount(row) || typeof sku !== 'string' || typeof message !== 'string') return null;
    rows.push({ row, sku, message });
  }

  const {
    total: supplierTotal,
    created: suppliersCreated,
    reused,
    failed: suppliersFailed,
    skipped,
    skippedReason,
  } = suppliers;
  if (
    !isCount(supplierTotal) ||
    !isCount(suppliersCreated) ||
    !isCount(reused) ||
    !isCount(suppliersFailed) ||
    typeof skipped !== 'boolean' ||
    (skippedReason !== null && typeof skippedReason !== 'string')
  ) {
    return null;
  }

  return {
    summary: {
      items: { total, created, failed, errors: rows },
      suppliers: {
        total: supplierTotal,
        created: suppliersCreated,
        reused,
        failed: suppliersFailed,
        skipped,
        skippedReason,
      },
    },
    processed,
    fileTotal,
  };
}
