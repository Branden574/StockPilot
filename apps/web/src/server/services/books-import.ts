import 'server-only';

import {
  assertWarehouseAccess,
  forcedWarehouseId,
  ForbiddenError,
} from '@/lib/auth/warehouse';
import { lookupIsbn, normalizeIsbn, type BookMetadata } from '@/lib/books/lookup';
import { safeFetch } from '@/lib/ssrf-guard';
import { generateSku } from '@/lib/utils';

import { PLANS, isUnlimited, type PlanId } from '@stockpilot/core';

import { assertPermission, ServiceError, type ServiceContext } from './context';

// Hosts the book-lookup pipeline ever returns thumbnails from. Anything
// else gets rejected by rehostCover() — a poisoned upstream API
// response with a thumbnail URL pointing at an internal service can't
// turn into an SSRF probe via the bulk-import flow.
const COVER_HOST_ALLOWLIST = [
  'books.google.com',
  'books.googleusercontent.com',
  'covers.openlibrary.org',
  'archive.org',
  'ia801600.us.archive.org',
  'ia803000.us.archive.org',
  'www.loc.gov',
  'tile.loc.gov',
];

/** 8s budget. Some cover servers are slow; 8s lets the slow ones resolve
 *  without blocking the whole import. */
const COVER_FETCH_TIMEOUT_MS = 8000;

/** Hard ceiling on a rehosted cover. Enforced while STREAMING, not after
 *  buffering — a hostile (or merely broken) cover host that omits or lies
 *  about Content-Length must not be able to make a serverless function
 *  buffer an unbounded body into memory. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** The only content types a rehosted cover may be STORED as. The remote
 *  server's `content-type` is attacker-influenced input, and Supabase
 *  Storage serves back whatever we upload it with — echoing e.g.
 *  `text/html` would turn our own storage origin into a stored-XSS host.
 *  Anything unrecognized is stored as a jpeg, matching the previous
 *  `ext` fallback. */
const COVER_MIME_BY_EXT = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
} as const;

/**
 * Reads at most `maxBytes` from a response body, aborting the transfer the
 * moment the cap is crossed. Returns null when the body is missing or the
 * cap is exceeded.
 */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel() — nothing to do.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
    // SSRF guard: the upstream book lookup APIs return raw thumbnail
    // URLs. If any of them were ever compromised or returned an
    // attacker-controlled URL pointing at a private IP, fetching it
    // here would let the attacker probe internal infra (and on Vercel
    // potentially hit IMDS for credentials). Allowlist the real
    // cover-image hosts we know about; reject everything else.
    //
    // MED-25 (security wave E): this was `assertSafeFetchUrl()` followed by
    // a bare `fetch()`. That pairing has two holes the guard's own doc
    // comment calls out. (1) TOCTOU — the hostname is resolved once for
    // validation and again by fetch(), so a DNS rebinder can answer public
    // then private. (2) REDIRECTS — `fetch` follows them by default and
    // nothing re-validates the hop, which matters here more than anywhere
    // else in the codebase because the Open Library cover URLs we fetch
    // are EXPECTED to redirect (covers.openlibrary.org -> ia*.us.archive
    // .org). A cover host could redirect us straight to
    // http://169.254.169.254/ and the allowlist would never see it.
    // `safeFetch` pins the validated IP for the connect and re-runs the
    // FULL guard (private ranges + this allowlist) on every hop's Location.
    const res = await safeFetch(coverUrl, {
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
      // Some cover servers gate on user-agent — pretend to be a browser.
      headers: { 'User-Agent': 'Mozilla/5.0 (StockPilot bulk-import)' },
      hostAllowlist: COVER_HOST_ALLOWLIST,
    });
    if (!res.ok) return null;

    // Cheap reject on an advertised over-size before reading a byte; the
    // streaming cap below is what actually enforces it.
    const advertised = Number(res.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > MAX_COVER_BYTES) return null;

    const arr = await readBoundedBody(res, MAX_COVER_BYTES);
    if (!arr || arr.byteLength === 0) return null;
    const remoteType = res.headers.get('content-type') ?? '';
    const ext =
      remoteType.includes('png') ? 'png' :
      remoteType.includes('webp') ? 'webp' : 'jpg';
    const contentType = COVER_MIME_BY_EXT[ext];
    const path = `${ctx.organizationId}/${itemId}/cover.${ext}`;

    const { error: upErr } = await ctx.supabase.storage
      .from('item-images')
      .upload(path, arr, {
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
    if (insertErr) {
      // DB insert failed AFTER the cover image was uploaded — remove
      // the orphan file so we don't accumulate cover-image storage
      // forever on intermittent RLS / constraint failures. Best-effort;
      // we still return null to the caller.
      try {
        await ctx.supabase.storage.from('item-images').remove([path]);
      } catch {
        // swallow — orphan is the lesser problem.
      }
      return null;
    }
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
   *
   * Perf shape (vs. the pre-batch version that called inv.create() per row):
   *
   *  - Per-batch-INVARIANT checks (permission, plan limit, warehouse
   *    access, (warehouse, charter) pairing) run ONCE before the loop
   *    instead of once per row. inv.create() repeats those for every
   *    call, which is unnecessary here: every row in a single import
   *    targets the same (warehouseId, charterId) pair and the same user
   *    so the answers are identical.
   *
   *  - All inventory_items rows go in via ONE batch insert; the matching
   *    stock_movements rows go in via ONE batch insert. For a 100-row
   *    import that's ~2 DB round trips for writes instead of ~200.
   *
   *  - rehostCover (network-bound: fetch upstream cover → upload to our
   *    bucket) runs in parallel batches of 5 so we use the Vercel
   *    function's wall-clock for I/O instead of sleeping serially.
   *    Cover-rehost failures stay non-fatal — the book row already
   *    exists with the third-party URL on custom_fields.thumbnail_url
   *    as a fallback.
   *
   * Failure contract (changed from the per-row version on purpose):
   *  - If the BATCH insert hits a constraint violation (duplicate SKU
   *    across the org, etc.), the whole batch is rejected by Postgres.
   *    No partial state — the user sees a single error and can fix the
   *    spreadsheet. This is a better UX than the old "some got created,
   *    some didn't" partial-import.
   *  - Per-row preview failures (invalid_isbn, lookup_failed) still get
   *    aggregated into result.failed[] as before.
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

    const result: BulkImportResult = { created: 0, skipped: 0, failed: [] };

    // -- Phase 1: classify each preview row, accumulate the ready ones. ----
    // Per-row preview failures (invalid / lookup_failed / missing title) and
    // duplicates resolve to result.failed[] / result.skipped here without
    // touching the DB.
    interface ReadyRow {
      isbn: string;
      title: string;
      customFields: Record<string, unknown>;
      thumbnailUrl: string | null;
    }
    const readyRows: ReadyRow[] = [];

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

      const customFields: Record<string, unknown> = {};
      if (row.metadata.authors.length > 0)
        customFields.author = row.metadata.authors.join(', ');
      if (row.metadata.publisher) customFields.publisher = row.metadata.publisher;
      if (row.metadata.publishedDate)
        customFields.published_date = row.metadata.publishedDate;
      if (row.metadata.grade) customFields.book_grade = row.metadata.grade;
      // Keep the third-party URL on custom_fields as a backup; the primary
      // surface for image rendering becomes the rehosted copy in our own
      // item-images bucket (Phase 4).
      if (row.metadata.thumbnailUrl)
        customFields.thumbnail_url = row.metadata.thumbnailUrl;

      readyRows.push({
        isbn: row.isbn,
        title: row.metadata.title,
        customFields,
        thumbnailUrl: row.metadata.thumbnailUrl,
      });
    }

    if (readyRows.length === 0) return result;

    // -- Phase 2: hoist invariant checks ONCE for the whole batch. ---------
    // These run per-row inside inv.create() in the legacy path; they don't
    // need to. The (user, warehouse, charter) tuple is fixed for the whole
    // import.
    assertPermission(this.ctx, 'items:create');

    const forced = await forcedWarehouseId(this.ctx);
    const resolvedWarehouseId = forced ?? options.warehouseId;
    if (!resolvedWarehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be selected before creating an item.',
      );
    }
    if (!forced) {
      // Manager/admin path: validate write access to the chosen warehouse.
      try {
        await assertWarehouseAccess(resolvedWarehouseId, 'write', this.ctx);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          throw new ServiceError('forbidden', err.message);
        }
        throw err;
      }
    }

    const resolvedCharterId = options.charterId ?? null;
    if (resolvedCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', resolvedWarehouseId)
        .eq('charter_id', resolvedCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'This charter is not serviced by the chosen warehouse. Pick a different one or mark the item as Generic.',
        );
      }
    }

    // Plan-limit gate. The per-row assertPlanLimit() only checks
    // `currentCount >= limit` — fine for single inserts, wrong for a
    // 100-row batch since it never accounts for what we're about to add.
    // Do the math once with `currentCount + batchSize` and reject upfront
    // so we don't half-insert and leave the org pinned at the limit.
    const { data: orgRow } = await this.ctx.supabase
      .from('organizations')
      .select('plan')
      .eq('id', this.ctx.organizationId)
      .single();
    const planId: PlanId = ((orgRow?.plan as PlanId | undefined) ?? 'free') as PlanId;
    const itemLimit = PLANS[planId].limits.items;
    if (!isUnlimited(itemLimit)) {
      const { count } = await this.ctx.supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null);
      const currentCount = count ?? 0;
      if (currentCount + readyRows.length > itemLimit) {
        throw new ServiceError(
          'plan_limit_exceeded',
          `Importing ${readyRows.length} books would exceed your ${PLANS[planId].name} plan limit of ${itemLimit} items (currently at ${currentCount}). Upgrade your plan or import fewer books.`,
          { plan: planId, limit: itemLimit, resource: 'items', currentCount, requested: readyRows.length },
        );
      }
    }

    // -- Phase 3: build all payloads in JS, then ONE batch insert. ---------
    // SKUs are generated locally (same as inv.create() does). Duplicate-SKU
    // collisions inside the batch itself or against existing rows surface
    // as a single 23505 from Postgres, which we translate to a clear
    // "import failed on row X" message below.
    const itemInserts = readyRows.map((r) => ({
      organization_id: this.ctx.organizationId,
      warehouse_id: resolvedWarehouseId,
      charter_id: resolvedCharterId,
      sku: generateSku(r.title),
      barcode: r.isbn,
      name: r.title,
      description: null,
      category_id: null,
      supplier_id: null,
      primary_location_id: null,
      unit_cost: 0,
      retail_price: 0,
      quantity_on_hand: defaultQty,
      reorder_point: 0,
      reorder_quantity: 0,
      unit_of_measure: 'unit',
      bin_location: null,
      tracking_type: 'none' as const,
      item_type: 'book' as const,
      custom_fields: r.customFields,
      status: 'active' as const,
      created_by: this.ctx.userId,
      updated_by: this.ctx.userId,
    }));

    const { data: insertedRaw, error: insertErr } = await this.ctx.supabase
      .from('inventory_items')
      .insert(itemInserts)
      .select('id, barcode');

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Unique violation — typically duplicate SKU/barcode across the
        // org. Postgres doesn't tell us WHICH row caused it on a batch
        // insert, but the message usually carries the conflicting value.
        // Surface a structured, user-actionable error.
        throw new ServiceError(
          'conflict',
          `Import rejected: at least one book conflicts with an existing item (duplicate SKU or barcode). No books were imported. ${insertErr.message}`,
          { batchSize: readyRows.length, postgresMessage: insertErr.message },
        );
      }
      throw new ServiceError('internal_error', insertErr.message);
    }

    const inserted = (insertedRaw ?? []) as Array<{ id: string; barcode: string }>;
    result.created = inserted.length;

    // Batch stock_movements for rows with a positive starting quantity.
    if (defaultQty > 0 && inserted.length > 0) {
      const movementInserts = inserted.map((row) => ({
        organization_id: this.ctx.organizationId,
        item_id: row.id,
        movement_type: 'initial' as const,
        quantity_change: defaultQty,
        previous_quantity: 0,
        new_quantity: defaultQty,
        user_id: this.ctx.userId,
        to_location_id: null,
      }));
      const { error: movementErr } = await this.ctx.supabase
        .from('stock_movements')
        .insert(movementInserts);
      if (movementErr) {
        // The inventory rows are already in. Don't fail the whole import
        // for an audit-trail row failure — log via the failed[] channel so
        // the UI surfaces it, but keep result.created as-is.
        result.failed.push({
          isbn: 'batch:stock_movements',
          reason: `Initial stock movement insert failed: ${movementErr.message}`,
        });
      }
    }

    // -- Phase 4: rehost cover images in parallel, capped at 5 in flight. -
    // These are network-bound (fetch from Google/OL/LoC, upload to Storage)
    // and independent per book. Running them serially is what made the
    // legacy import blow past Vercel Hobby's 10s timeout. Failures are
    // non-fatal — the book row already exists with custom_fields.thumbnail_url
    // as a fallback for the inventory list image.
    const coverTargets = inserted
      .map((ins) => {
        const ready = readyRows.find((r) => r.isbn === ins.barcode);
        if (!ready || !ready.thumbnailUrl) return null;
        return { itemId: ins.id, url: ready.thumbnailUrl };
      })
      .filter((x): x is { itemId: string; url: string } => x !== null);

    if (coverTargets.length > 0) {
      const COVER_CONCURRENCY = 5;
      await runInBatches(coverTargets, COVER_CONCURRENCY, async (target) => {
        // rehostCover already swallows all errors and returns null on
        // failure — this won't throw, but wrap in case the contract
        // changes later. Don't surface cover failures in result.failed
        // since they're an enhancement, not a missing book.
        try {
          await rehostCover(this.ctx, target.itemId, target.url);
        } catch {
          // best-effort
        }
      });
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

/**
 * Run `fn` over `items` with at most `batchSize` calls in flight at a time.
 * Used to parallelize cover rehosting (each rehost is ~1 outbound fetch +
 * 1 storage upload + 1 row insert; doing them sequentially is what tipped
 * 100-book imports past Vercel's function timeout).
 *
 * Concurrency is bounded so we don't saturate the function's outbound socket
 * pool or get rate-limited by Google Books / Open Library.
 */
async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
