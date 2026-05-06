import 'server-only';

import { lookupIsbn, normalizeIsbn, type BookMetadata } from '@/lib/books/lookup';
import { generateSku } from '@/lib/utils';

import { InventoryService } from './inventory';
import { ServiceError, type ServiceContext } from './context';

/**
 * Download a cover image from a third-party URL and host it in our
 * Supabase Storage bucket so the inventory list doesn't depend on
 * archive.org / Google Books / etc. for image rendering. Open
 * Library covers redirect to archive.org which often returns
 * ERR_CONNECTION_RESET from many networks (corporate firewalls,
 * Brave Shields, school Wi-Fi). Re-hosting eliminates that.
 *
 * Returns the storage path on success, null on any failure. Failures
 * are non-fatal — the book row already exists with the original URL
 * in custom_fields.thumbnail_url as a backup.
 */
async function rehostCover(
  ctx: ServiceContext,
  itemId: string,
  coverUrl: string,
): Promise<string | null> {
  try {
    // 8s budget. Some cover servers are slow; 8s lets the slow ones
    // resolve without blocking the whole import.
    const res = await fetch(coverUrl, {
      signal: AbortSignal.timeout(8000),
      // Some cover servers gate on user-agent — pretend to be a browser.
      headers: { 'User-Agent': 'Mozilla/5.0 (StockPilot bulk-import)' },
    });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    if (arr.byteLength === 0 || arr.byteLength > 5 * 1024 * 1024) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const ext =
      contentType.includes('png') ? 'png' :
      contentType.includes('webp') ? 'webp' : 'jpg';
    const path = `${ctx.organizationId}/${itemId}/cover.${ext}`;

    const { error: upErr } = await ctx.supabase.storage
      .from('item-images')
      .upload(path, new Uint8Array(arr), {
        contentType,
        cacheControl: '604800', // 1 week — covers don't change
        upsert: true,
      });
    if (upErr) return null;

    const { error: insertErr } = await ctx.supabase.from('item_images').insert({
      organization_id: ctx.organizationId,
      item_id: itemId,
      storage_path: path,
      is_primary: true,
      sort_order: 0,
      alt: null,
    });
    if (insertErr) return null;
    return path;
  } catch {
    // Network/abort/etc. — best-effort, swallow and move on.
    return null;
  }
}

/**
 * Bulk-ISBN import preview + execution. Designed to back the AI
 * tools (previewBulkBookImport / executeBulkBookImport) without
 * duplicating logic that already lives in the dashboard import
 * page's server action.
 *
 * Two distinct phases on purpose:
 *   1. preview() runs lookups, validates ISBNs, and detects duplicates
 *      both within the input list and against existing inventory rows.
 *      Read-only — never writes anything.
 *   2. execute() takes the same input + a `skipDuplicates` flag and
 *      creates inventory_items for everything that passes validation.
 *      It re-runs the same checks at write time so a stale preview
 *      can't cause double-inserts.
 *
 * Duplicate detection rule: a book is considered a duplicate when an
 * existing non-deleted inventory_item in the same organization has
 * `barcode = <isbn>`. (Bulk imports use the ISBN as the barcode.)
 */

const MAX_PER_BATCH = 50;

export type PreviewStatus =
  | 'ready'
  | 'duplicate_in_db'
  | 'duplicate_in_list'
  | 'lookup_failed'
  | 'invalid_isbn';

export interface BulkImportPreviewRow {
  /** As supplied by the caller — preserved for echo-back. */
  rawIsbn: string;
  /** Normalized 10/13-digit form, or null when invalid. */
  isbn: string | null;
  status: PreviewStatus;
  /** Title etc. — populated when status === 'ready'. */
  metadata: {
    title: string | null;
    authors: string[];
    publisher: string | null;
    publishedDate: string | null;
    grade: string | null;
    /** Cover URL (Google Books / Open Library / LoC). Used by execute()
     *  to download + re-host the cover in our own bucket so the
     *  inventory list doesn't depend on a third party. */
    thumbnailUrl: string | null;
  } | null;
  /** Existing item, populated when status === 'duplicate_in_db'. */
  existing: {
    id: string;
    name: string;
    quantityOnHand: number;
  } | null;
  /** Human-readable error when status is 'lookup_failed' or 'invalid_isbn'. */
  error: string | null;
}

export interface BulkImportPreview {
  totals: {
    submitted: number;
    ready: number;
    duplicateInDb: number;
    duplicateInList: number;
    invalid: number;
    lookupFailed: number;
  };
  rows: BulkImportPreviewRow[];
}

export interface BulkImportExecuteOptions {
  warehouseId: string;
  charterId?: string | null;
  /** Default per-book quantity. The dashboard page asks the user for this. */
  defaultQuantity?: number;
  /**
   * When true (default), books flagged as duplicate_in_db / duplicate_in_list
   * are silently skipped. When false, duplicates abort the whole batch
   * with a conflict error so callers can decide.
   */
  skipDuplicates?: boolean;
}

export interface BulkImportResult {
  created: number;
  skipped: number;
  failed: Array<{ isbn: string; reason: string }>;
}

export class BooksImportService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Normalizes input, runs lookups in parallel, and tags each row with
   * a duplicate / failure / ready status. Doesn't write anything.
   */
  async preview(rawIsbns: string[]): Promise<BulkImportPreview> {
    if (rawIsbns.length === 0) {
      return {
        totals: {
          submitted: 0,
          ready: 0,
          duplicateInDb: 0,
          duplicateInList: 0,
          invalid: 0,
          lookupFailed: 0,
        },
        rows: [],
      };
    }
    if (rawIsbns.length > MAX_PER_BATCH) {
      throw new ServiceError(
        'validation_error',
        `Bulk import is capped at ${MAX_PER_BATCH} ISBNs per batch via the assistant. Use /dashboard/books/import for larger batches (up to 200).`,
      );
    }

    // Phase 1 — normalize + tag duplicates within the list. We track
    // the FIRST occurrence as the "ready" candidate; subsequent copies
    // become duplicate_in_list rows.
    const seenInList = new Set<string>();
    const normalized: Array<{ raw: string; isbn: string | null; dupeInList: boolean }> = [];
    for (const raw of rawIsbns) {
      const isbn = normalizeIsbn(raw);
      if (!isbn) {
        normalized.push({ raw, isbn: null, dupeInList: false });
        continue;
      }
      const dupe = seenInList.has(isbn);
      if (!dupe) seenInList.add(isbn);
      normalized.push({ raw, isbn, dupeInList: dupe });
    }

    // Phase 2 — DB existence check for the unique normalized ISBNs.
    const uniqueIsbns = [...seenInList];
    const existingByIsbn = new Map<
      string,
      { id: string; name: string; quantityOnHand: number }
    >();
    if (uniqueIsbns.length > 0) {
      const { data, error } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, name, barcode, quantity_on_hand')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .in('barcode', uniqueIsbns);
      if (error) throw new ServiceError('internal_error', error.message);
      for (const row of (data ?? []) as Array<{
        id: string;
        name: string;
        barcode: string;
        quantity_on_hand: number;
      }>) {
        existingByIsbn.set(row.barcode, {
          id: row.id,
          name: row.name,
          quantityOnHand: row.quantity_on_hand,
        });
      }
    }

    // Phase 3 — concurrency-limited lookups for entries that aren't
    // already disqualified. 4 in flight matches the dashboard page.
    const rows: BulkImportPreviewRow[] = normalized.map((n) => ({
      rawIsbn: n.raw,
      isbn: n.isbn,
      status: 'ready',
      metadata: null,
      existing: null,
      error: null,
    }));

    for (let i = 0; i < normalized.length; i++) {
      const n = normalized[i]!;
      const row = rows[i]!;
      if (!n.isbn) {
        row.status = 'invalid_isbn';
        row.error = 'Not a valid ISBN-10 or ISBN-13.';
        continue;
      }
      if (n.dupeInList) {
        row.status = 'duplicate_in_list';
        row.error = 'Already appears earlier in this list.';
        continue;
      }
      const dbHit = existingByIsbn.get(n.isbn);
      if (dbHit) {
        row.status = 'duplicate_in_db';
        row.existing = dbHit;
        continue;
      }
    }

    const lookupTargets: Array<{ rowIndex: number; isbn: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.status === 'ready' && r.isbn) lookupTargets.push({ rowIndex: i, isbn: r.isbn });
    }

    const concurrency = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < lookupTargets.length) {
        const idx = cursor++;
        const t = lookupTargets[idx]!;
        try {
          const meta = await lookupIsbn(t.isbn);
          if (!meta || !meta.title) {
            rows[t.rowIndex]!.status = 'lookup_failed';
            rows[t.rowIndex]!.error = 'No metadata found across sources.';
          } else {
            rows[t.rowIndex]!.metadata = pickPreviewMeta(meta);
          }
        } catch (err) {
          rows[t.rowIndex]!.status = 'lookup_failed';
          rows[t.rowIndex]!.error = err instanceof Error ? err.message : 'Lookup error';
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, lookupTargets.length) }, worker),
    );

    return { totals: tally(rows), rows };
  }

  /**
   * Re-validates each ISBN, runs duplicate checks again, and creates
   * inventory_items for the ones that pass. The preview is advisory —
   * we never trust it as the source of truth at write time.
   */
  async execute(
    rawIsbns: string[],
    options: BulkImportExecuteOptions,
  ): Promise<BulkImportResult> {
    if (!options.warehouseId) {
      throw new ServiceError('validation_error', 'warehouseId is required');
    }
    const skipDuplicates = options.skipDuplicates ?? true;
    const defaultQty = Math.max(0, Math.floor(options.defaultQuantity ?? 1));

    const preview = await this.preview(rawIsbns);
    if (!skipDuplicates) {
      const blockers = preview.rows.filter(
        (r) => r.status === 'duplicate_in_db' || r.status === 'duplicate_in_list',
      );
      if (blockers.length > 0) {
        throw new ServiceError(
          'conflict',
          `${blockers.length} duplicate(s) detected — re-run with skipDuplicates=true to import only the new books.`,
        );
      }
    }

    const inv = new InventoryService(this.ctx);
    const result: BulkImportResult = { created: 0, skipped: 0, failed: [] };

    for (const row of preview.rows) {
      if (row.status === 'duplicate_in_db' || row.status === 'duplicate_in_list') {
        result.skipped += 1;
        continue;
      }
      if (row.status === 'invalid_isbn' || row.status === 'lookup_failed') {
        result.failed.push({
          isbn: row.rawIsbn,
          reason: row.error ?? row.status,
        });
        continue;
      }
      if (!row.isbn || !row.metadata?.title) {
        result.failed.push({ isbn: row.rawIsbn, reason: 'missing title' });
        continue;
      }

      try {
        const customFields: Record<string, unknown> = {};
        if (row.metadata.authors.length > 0)
          customFields.author = row.metadata.authors.join(', ');
        if (row.metadata.publisher) customFields.publisher = row.metadata.publisher;
        if (row.metadata.publishedDate)
          customFields.published_date = row.metadata.publishedDate;
        if (row.metadata.grade) customFields.book_grade = row.metadata.grade;
        // Keep the third-party URL in custom_fields as a backup; the
        // primary surface for image rendering becomes the rehosted
        // copy in our own item-images bucket (below).
        if (row.metadata.thumbnailUrl)
          customFields.thumbnail_url = row.metadata.thumbnailUrl;

        const created = (await inv.create({
          name: row.metadata.title,
          sku: generateSku(row.metadata.title),
          barcode: row.isbn,
          itemType: 'book',
          quantityOnHand: defaultQty,
          unitCost: 0,
          retailPrice: 0,
          warehouseId: options.warehouseId,
          charterId: options.charterId ?? null,
          unitOfMeasure: 'unit',
          customFields,
          status: 'active',
          reorderPoint: 0,
          reorderQuantity: 0,
          trackingType: 'none',
        })) as { id?: string } | null;

        // Re-host the cover image in our bucket. Best-effort: if it
        // fails (cover URL unreachable, storage quota, etc.) the book
        // is still created, and the inventory list falls back to the
        // custom_fields.thumbnail_url we just stashed.
        if (created?.id && row.metadata.thumbnailUrl) {
          await rehostCover(this.ctx, created.id, row.metadata.thumbnailUrl);
        }

        result.created += 1;
      } catch (err) {
        if (err instanceof ServiceError && err.code === 'conflict') {
          // Race: someone else inserted this ISBN between preview and
          // execute. Treat as skipped, not an error.
          result.skipped += 1;
        } else {
          result.failed.push({
            isbn: row.isbn,
            reason: err instanceof Error ? err.message : 'create failed',
          });
        }
      }
    }

    return result;
  }

  /**
   * Backfill rehosted covers for books that already exist in the DB
   * but only have a third-party URL on custom_fields.thumbnail_url
   * (no item_images row). Lets users repair the existing library
   * after the rehost flow landed without re-importing.
   *
   * Goes book-by-book, best-effort: a single failed cover doesn't
   * abort the run. Returns counts so the UI can surface "rehosted X
   * of Y, skipped Z (already had a primary photo), failed F".
   */
  async backfillCovers(options: { limit?: number } = {}): Promise<{
    rehosted: number;
    alreadyHadPrimary: number;
    noUrlOnRow: number;
    failed: number;
    scanned: number;
  }> {
    const limit = Math.min(options.limit ?? 200, 500);
    const stats = {
      rehosted: 0,
      alreadyHadPrimary: 0,
      noUrlOnRow: 0,
      failed: 0,
      scanned: 0,
    };

    // Pull books in this org with a thumbnail_url stashed on
    // custom_fields. The .not('custom_fields->>thumbnail_url', 'is', null)
    // filter narrows to rows that actually have a candidate cover —
    // no point fetching covers for items the importer never tagged.
    const { data: rows, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, custom_fields')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_type', 'book')
      .is('deleted_at', null)
      .not('custom_fields->>thumbnail_url', 'is', null)
      .limit(limit);
    if (error) throw new ServiceError('internal_error', error.message);

    for (const row of (rows ?? []) as Array<{
      id: string;
      custom_fields: Record<string, unknown> | null;
    }>) {
      stats.scanned += 1;
      const thumb =
        row.custom_fields && typeof row.custom_fields === 'object'
          ? (row.custom_fields.thumbnail_url as string | undefined)
          : undefined;
      if (!thumb || typeof thumb !== 'string' || thumb.length === 0) {
        stats.noUrlOnRow += 1;
        continue;
      }

      // Skip if a primary image already exists. Don't clobber a real
      // user-uploaded photo with a stale URL.
      const { data: existing } = await this.ctx.supabase
        .from('item_images')
        .select('id')
        .eq('item_id', row.id)
        .eq('is_primary', true)
        .limit(1);
      if (existing && existing.length > 0) {
        stats.alreadyHadPrimary += 1;
        continue;
      }

      const path = await rehostCover(this.ctx, row.id, thumb);
      if (path) stats.rehosted += 1;
      else stats.failed += 1;
    }

    return stats;
  }
}

function pickPreviewMeta(meta: BookMetadata) {
  return {
    title: meta.title,
    authors: meta.authors,
    publisher: meta.publisher,
    publishedDate: meta.publishedDate,
    grade: meta.grade,
    thumbnailUrl: meta.thumbnailUrl,
  };
}

function tally(rows: BulkImportPreviewRow[]): BulkImportPreview['totals'] {
  const t = {
    submitted: rows.length,
    ready: 0,
    duplicateInDb: 0,
    duplicateInList: 0,
    invalid: 0,
    lookupFailed: 0,
  };
  for (const r of rows) {
    if (r.status === 'ready') t.ready += 1;
    else if (r.status === 'duplicate_in_db') t.duplicateInDb += 1;
    else if (r.status === 'duplicate_in_list') t.duplicateInList += 1;
    else if (r.status === 'invalid_isbn') t.invalid += 1;
    else if (r.status === 'lookup_failed') t.lookupFailed += 1;
  }
  return t;
}
