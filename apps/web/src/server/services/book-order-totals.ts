import 'server-only';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { isTrustedCoverUrl } from '@/lib/reports/book-order-totals/trusted-cover-url';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

import {
  BOOK_REPORT_COVERS_MAX,
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_INVALID_CHARTER,
  BOOK_REPORT_ORDERS_PAGE_SIZE,
  BOOK_REPORT_PAGE_SIZE,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_PDF_MAX_ROWS,
  BOOK_REPORT_NOT_IN_SCOPE,
  BOOK_REPORT_TIMEOUT,
  bookReportCharterEchoMatches,
  bookReportFilterArgs,
  bookReportStatusLabels,
  bookReportTooManyText,
  can,
  isUuid,
  parseBookOrderOptionsAnswer,
  parseBookOrderOrdersAnswer,
  parseBookOrderTotalsAnswer,
  sumReportQuantities,
  type BookOrderOptionsResponse,
  type BookOrderOrdersResponse,
  type BookOrderTotalsResponse,
  type BookReportCharterFilters,
  type BookReportFilterArgs,
  type BookReportQuery,
  type ResolvedBookReportWarehouse,
} from '@stockpilot/core';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { ItemImagesService } from './item-images';

/**
 * BOOK ORDER TOTALS — the one authoritative server method behind the web
 * page, the /api/v1 routes the phone and the web drawer call, the covers,
 * and the CSV and PDF exports.
 *
 * SQL is the only calculator (migrations 0379 and 0382: 0382 adds the
 * ORDER's charter and the Today and This week presets). Every read here goes
 * through the CALLER's client, so orders, lines, items and warehouses RLS apply on
 * top of the functions' own gates; the organization id is always the
 * verified context's, never the client's. The only privileged step is the
 * existing storage signing inside ItemImagesService, reached only for item
 * ids the caller's own RLS read returned.
 *
 * The gate is stricter than the sibling reports on purpose: reports:read
 * with the MFA step-up (assertPermission) and both the orders and books
 * modules, checked before any read.
 */

type RpcError = { code?: string; message?: string; hint?: string | null; details?: string | null };

const VALIDATION_HINTS = new Set([
  'invalid_status',
  'invalid_search',
  'invalid_warehouse',
  'invalid_category',
  'invalid_range',
  'invalid_sort',
  'invalid_item',
  'invalid_charter',
]);

const VALIDATION_MESSAGES: Record<string, string> = {
  invalid_status: 'Choose at least one order status from the list.',
  invalid_search: 'That ISBN search could not be read.',
  invalid_warehouse: 'That warehouse is not one you can see.',
  invalid_category: 'That category is not one you can see.',
  invalid_range: 'Choose a real date range between 2000 and 2100, first date first.',
  invalid_sort: 'That sort order is not available.',
  invalid_item: 'Choose a book.',
  // One message for every cause (an unknown id, another organization's
  // charter, one outside the caller's scope, or a charter sent with No
  // charter): the refusal names nothing and teaches nothing (plan D3).
  invalid_charter: BOOK_REPORT_INVALID_CHARTER,
};

/**
 * One mapping from the functions' errors to ServiceError. The raw database
 * text never leaves the server (S13): an unexpected error is internal_error
 * with the code reported, never its message.
 */
export function mapBookReportRpcError(
  error: RpcError,
  tag: string,
  organizationId?: string,
): ServiceError {
  const code = error.code ?? '';
  const hint = error.hint ?? '';
  if (code === '42501' && hint === 'unauthenticated') {
    return new ServiceError('unauthenticated', 'Sign in again to open this report.');
  }
  if (code === '42501') {
    return new ServiceError('forbidden', 'Missing permission: reports:read');
  }
  if (code === 'P0001' && hint === 'module_disabled') {
    return new ServiceError(
      'module_disabled',
      'Book Order Totals needs the Orders and Books modules.',
    );
  }
  if (code === '22023' && VALIDATION_HINTS.has(hint)) {
    return new ServiceError(
      'validation_error',
      VALIDATION_MESSAGES[hint] ?? 'That filter is not valid.',
      {
        reason: hint,
      },
    );
  }
  if (code === '57014') {
    void reportError(new Error('book_order_totals statement timeout'), {
      tag,
      level: 'warning',
      organizationId: organizationId ?? null,
      extra: { code },
    });
    return new ServiceError('internal_error', BOOK_REPORT_TIMEOUT, { reason: 'timeout' });
  }
  void reportError(new Error(`book_order_totals rpc failed (${code || 'no code'})`), {
    tag,
    organizationId: organizationId ?? null,
    extra: { code: code || null },
  });
  return new ServiceError('internal_error', `book_order_totals rpc failed (${code || 'no code'})`);
}

/** The warehouse a v1 request names: the resolved query's concrete value.
 *  'default' never reaches an API route (400): a route answer must not
 *  depend on which cookie happens to ride along. */
export function warehouseFromResolvedQuery(query: BookReportQuery): ResolvedBookReportWarehouse {
  if (query.warehouse === 'all') return { id: null, source: 'all' };
  if (isUuid(query.warehouse)) {
    return { id: query.warehouse, source: query.warehouseFromView ? 'view' : 'explicit' };
  }
  throw new ServiceError('validation_error', 'Name a warehouse, or all.', {
    reason: 'warehouse_required',
  });
}

/**
 * The web page's warehouse, resolved ONCE per render: the URL's own value
 * when it has one; otherwise the manager's warehouse view (the
 * sp_warehouse_filter cookie, checked against readable warehouses), else all.
 * Every derived link carries the result, never 'default'.
 */
export async function resolveBookReportWarehouse(
  query: BookReportQuery,
): Promise<ResolvedBookReportWarehouse> {
  if (query.warehouse !== 'default') return warehouseFromResolvedQuery(query);
  const view = await getActiveWarehouseFilter();
  return view ? { id: view, source: 'view' } : { id: null, source: 'all' };
}

export type BookReportExportFormat = 'csv' | 'pdf';

/** Cover URLs by item id, and the ids whose cover could not be loaded (not
 *  those with no cover at all). */
export interface BookCoverLookup {
  urls: Record<string, string>;
  unresolved: string[];
}

export const BOOK_REPORT_EXPORT_MAX_ROWS: Readonly<Record<BookReportExportFormat, number>> = {
  csv: BOOK_REPORT_CSV_MAX_ROWS,
  pdf: BOOK_REPORT_PDF_MAX_ROWS,
};

/**
 * The ORDER charter's RPC arguments, sent ONLY when used (plan D18): a charter
 * id as `p_charter_id`, No charter as `p_no_charter: true`, and neither key
 * for All charters. All-charters calls therefore resolve against the 0379 and
 * the 0382 functions alike, so a misordered deploy or a SQL-only revert
 * degrades only charter-filtered requests. Never `null` / `false` explicitly.
 */
export function bookReportCharterArgs(f: Pick<BookReportFilterArgs, 'charterId' | 'noCharter'>): {
  p_charter_id?: string;
  p_no_charter?: true;
} {
  if (f.charterId) return { p_charter_id: f.charterId };
  if (f.noCharter) return { p_no_charter: true };
  return {};
}

export class BookOrderTotalsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<BookOrderTotalsService> {
    return new BookOrderTotalsService(await withContext());
  }

  /** reports:read (MFA step-up first), then the orders and books modules. */
  gate(): void {
    assertPermission(this.ctx, 'reports:read');
    assertModuleEnabled(this.ctx, 'orders');
    assertModuleEnabled(this.ctx, 'books');
  }

  private totalsArgs(query: BookReportQuery, warehouse: ResolvedBookReportWarehouse) {
    const f = bookReportFilterArgs(query);
    return {
      p_organization_id: this.ctx.organizationId,
      p_range: f.range,
      p_from_date: f.from,
      p_to_date: f.to,
      p_statuses: f.statuses,
      p_warehouse_id: warehouse.id,
      p_category_id: f.categoryId,
      p_uncategorized: f.uncategorized,
      p_search: f.search,
      p_isbn_keys: f.isbnKeys,
      p_sort: f.sort,
      ...bookReportCharterArgs(f),
    };
  }

  /** One page of grouped rows plus the summary and total count, from ONE
   *  statement. */
  async page(
    query: BookReportQuery,
    warehouse: ResolvedBookReportWarehouse,
  ): Promise<BookOrderTotalsResponse> {
    this.gate();
    const { data, error } = await this.ctx.supabase.rpc('book_order_totals', {
      ...this.totalsArgs(query, warehouse),
      p_page: query.page,
      p_page_size: BOOK_REPORT_PAGE_SIZE,
      p_all_rows: false,
      p_max_rows: null,
    });
    if (error)
      throw mapBookReportRpcError(error, 'reports.book_order_totals', this.ctx.organizationId);
    const answer = this.parse(() => parseBookOrderTotalsAnswer(data), 'reports.book_order_totals');
    this.assertCharterEcho(query, answer.filters, 'reports.book_order_totals');
    return { ...answer, organizationId: this.ctx.organizationId, warehouse };
  }

  /**
   * The drill-down for one book over the same range, statuses and warehouse.
   * A book the caller cannot see, a product and a missing id are the same
   * not_found. Each row's `mine` becomes `openable` (orders:approve, or the
   * caller's own request: the rule the Orders page uses to choose between
   * every order and "my requests"); `mine` itself is not passed on.
   */
  async orders(
    itemId: string,
    query: BookReportQuery,
    warehouse: ResolvedBookReportWarehouse,
    page: number,
  ): Promise<BookOrderOrdersResponse> {
    this.gate();
    if (!isUuid(itemId)) {
      throw new ServiceError('validation_error', 'Choose a book.', { reason: 'invalid_item' });
    }
    const f = bookReportFilterArgs(query);
    const { data, error } = await this.ctx.supabase.rpc('book_order_totals_orders', {
      p_organization_id: this.ctx.organizationId,
      p_item_id: itemId,
      p_range: f.range,
      p_from_date: f.from,
      p_to_date: f.to,
      p_statuses: f.statuses,
      p_warehouse_id: warehouse.id,
      p_page: page,
      p_page_size: BOOK_REPORT_ORDERS_PAGE_SIZE,
      ...bookReportCharterArgs(f),
    });
    if (error)
      throw mapBookReportRpcError(
        error,
        'reports.book_order_totals.orders',
        this.ctx.organizationId,
      );
    const answer = this.parse(
      () => parseBookOrderOrdersAnswer(data),
      'reports.book_order_totals.orders',
    );
    if (!answer.found) throw new ServiceError('not_found', BOOK_REPORT_NOT_IN_SCOPE);
    this.assertCharterEcho(query, answer.filters, 'reports.book_order_totals.orders');
    const approver = can(this.ctx, 'orders:approve');
    return {
      ...answer,
      organizationId: this.ctx.organizationId,
      warehouse,
      rows: answer.rows.map(({ mine, ...row }) => ({ ...row, openable: approver || mine })),
    };
  }

  /**
   * The filter lists: warehouses (any status) and categories (deleted ones
   * included) that occur in the caller's eligible lines; the charters the
   * caller may report on (0382: every active one they can reach, and
   * inactive or archived ones with visible book orders) and whether orders
   * with no charter are visible; and the organization's status labels. From
   * a server before 0382 the charter list is empty and noCharter false (the
   * core parser's defaults), so the Charter select offers All charters only.
   */
  async options(): Promise<BookOrderOptionsResponse> {
    this.gate();
    const { data, error } = await this.ctx.supabase.rpc('book_order_totals_options', {
      p_organization_id: this.ctx.organizationId,
    });
    if (error)
      throw mapBookReportRpcError(
        error,
        'reports.book_order_totals.options',
        this.ctx.organizationId,
      );
    const answer = this.parse(
      () => parseBookOrderOptionsAnswer(data),
      'reports.book_order_totals.options',
    );
    return {
      v: 1,
      organizationId: this.ctx.organizationId,
      warehouses: answer.warehouses,
      categories: answer.categories,
      uncategorized: answer.uncategorized,
      charters: answer.charters,
      noCharter: answer.noCharter,
      statusLabels: bookReportStatusLabels(answer.orderStatusConfig),
    };
  }

  /**
   * Covers for at most `max` books, as { itemId: url }. The books are
   * authorized FIRST with the caller's own RLS read of inventory_items (the
   * item_images policy is org-wide, so it cannot be the gate), and only the
   * ids that come back reach ItemImagesService, which applies the existing
   * precedence (uploaded primary cover first), path validation and signing
   * lifetimes, and falls back to an item's legacy thumbnail_url. Every URL
   * then passes the trust filter. Cosmetic: a failure is reported with
   * counts only (never a URL) and answers with what resolved, never an error
   * that could block the numbers.
   */
  async covers(
    itemIds: readonly string[],
    opts: { max?: number } = {},
  ): Promise<Record<string, string>> {
    return (await this.coverLookup(itemIds, opts)).urls;
  }

  /**
   * covers(), plus the books whose cover could not be LOADED, as distinct
   * from books that have none: the lookup failed, or the book's image row
   * could not be signed, or its URL was untrusted. The PDF counts these as
   * "could not be loaded" and the page and the phone say "Cover could not be
   * loaded" for them; "No cover" is only for a book with no image at all. A
   * book the caller's read does not return is simply absent from both, like
   * a book with no cover, so the answer says nothing RLS would not.
   */
  async coverLookup(
    itemIds: readonly string[],
    opts: { max?: number } = {},
  ): Promise<BookCoverLookup> {
    this.gate();
    const max = opts.max ?? BOOK_REPORT_COVERS_MAX;
    const ids = [...new Set(itemIds.filter(isUuid).map((id) => id.toLowerCase()))];
    if (ids.length > max) {
      throw new ServiceError('validation_error', `Ask for at most ${max} covers at a time.`, {
        reason: 'too_many_ids',
      });
    }
    if (ids.length === 0) return { urls: {}, unresolved: [] };
    const out: Record<string, string> = {};
    const unresolvedOf = (resolvedOrNone: ReadonlySet<string>) =>
      ids.filter((id) => !(id in out) && !resolvedOrNone.has(id));
    try {
      const ctx = this.ctx;
      const readable = await fetchAllRowsByIds<{ id: string }>(
        ids,
        (batch) => (from, to) =>
          ctx.supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .eq('item_type', 'book')
            .eq('is_bundle', false)
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      const allowed = readable.map((r) => r.id).filter((id) => ids.includes(id));
      // Unreadable (hidden or missing) books are absent, never "unresolved".
      const none = new Set(ids.filter((id) => !allowed.includes(id)));
      if (allowed.length === 0) return { urls: out, unresolved: [] };
      const imaged = new Set<string>();
      const urls = await new ItemImagesService(ctx).primaryMasterUrlsForItems(allowed, {
        imaged,
      });
      let dropped = 0;
      // A readable book with no URL and no image row simply has no cover.
      for (const id of allowed) {
        const url = urls.get(id);
        if (!url) {
          if (!imaged.has(id)) none.add(id);
          continue;
        }
        if (isTrustedCoverUrl(url, env.NEXT_PUBLIC_SUPABASE_URL)) out[id] = url;
        else dropped += 1;
      }
      if (dropped > 0) {
        void reportError(new Error('book cover url not trusted'), {
          tag: 'reports.book_order_totals.covers',
          level: 'warning',
          organizationId: ctx.organizationId,
          extra: { count: allowed.length, dropped },
        });
      }
      return { urls: out, unresolved: unresolvedOf(none) };
    } catch (e) {
      void reportError(e instanceof ServiceError ? new Error(`covers failed: ${e.code}`) : e, {
        tag: 'reports.book_order_totals.covers',
        level: 'warning',
        organizationId: this.ctx.organizationId,
        extra: { count: ids.length, failed: ids.length - Object.keys(out).length },
      });
      return { urls: out, unresolved: unresolvedOf(new Set()) };
    }
  }

  /** The PDF's covers: the first BOOK_REPORT_PDF_COVER_CAP rows only. */
  async pdfCovers(itemIds: readonly string[]): Promise<BookCoverLookup> {
    return this.coverLookup(itemIds.slice(0, BOOK_REPORT_PDF_COVER_CAP), {
      max: BOOK_REPORT_PDF_COVER_CAP,
    });
  }

  /**
   * Every grouped row for an export, with the summary, from ONE export-mode
   * statement (one snapshot; no page loop). Above the format's ceiling the
   * database returns tooMany with no rows, and this refuses before any byte
   * of a file is written; it never truncates. The answer is then checked
   * against itself (unique rows, rows = count = entries, the rows' copies add
   * up to the summary) and a failure is an internal error, never a partial
   * file.
   */
  async exportRows(
    query: BookReportQuery,
    warehouse: ResolvedBookReportWarehouse,
    format: BookReportExportFormat,
  ): Promise<BookOrderTotalsResponse> {
    this.gate();
    // The file path: reports:export as well (the route checks it first; the
    // database refuses export mode without it too).
    assertPermission(this.ctx, 'reports:export');
    const limit = BOOK_REPORT_EXPORT_MAX_ROWS[format];
    const { data, error } = await this.ctx.supabase.rpc('book_order_totals', {
      ...this.totalsArgs(query, warehouse),
      p_page: 1,
      p_page_size: null,
      p_all_rows: true,
      p_max_rows: limit,
    });
    if (error)
      throw mapBookReportRpcError(
        error,
        'reports.book_order_totals.export',
        this.ctx.organizationId,
      );
    const answer = this.parse(
      () => parseBookOrderTotalsAnswer(data),
      'reports.book_order_totals.export',
    );
    if (answer.mode !== 'all') {
      throw this.selfCheckFailure('mode');
    }
    this.assertCharterEcho(query, answer.filters, 'reports.book_order_totals.export');
    if (answer.tooMany) {
      throw new ServiceError('validation_error', bookReportTooManyText(answer.totalCount, limit), {
        reason: 'too_many_rows',
        count: answer.totalCount,
        limit,
      });
    }
    const ids = new Set(answer.rows.map((r) => r.itemId));
    if (ids.size !== answer.rows.length) throw this.selfCheckFailure('duplicate_rows');
    if (answer.rows.length !== answer.totalCount || answer.totalCount !== answer.summary.entries) {
      throw this.selfCheckFailure('row_count');
    }
    const copies = sumReportQuantities(
      answer.rows.filter((r) => r.countsAsCopies).map((r) => r.copies),
    );
    const other = sumReportQuantities(
      answer.rows.filter((r) => !r.countsAsCopies).map((r) => r.copies),
    );
    if (copies !== sumReportQuantities([answer.summary.copies]))
      throw this.selfCheckFailure('copies');
    if (other !== sumReportQuantities([answer.summary.unresolved.quantity]))
      throw this.selfCheckFailure('other_units');
    if (answer.rows.filter((r) => !r.countsAsCopies).length !== answer.summary.unresolved.entries) {
      throw this.selfCheckFailure('other_unit_entries');
    }
    return { ...answer, organizationId: this.ctx.organizationId, warehouse };
  }

  /**
   * An answer is used only if it says it is for the charter asked for (core
   * bookReportCharterEchoMatches): figures are never shown or filed under a
   * charter they are not for. It cannot fail against a 0382 database (the
   * echo comes from the same statement) or for All charters against 0379 (no
   * charter keys at all); anything else is an internal error, never a page.
   */
  private assertCharterEcho(
    query: BookReportQuery,
    filters: BookReportCharterFilters,
    tag: string,
  ): void {
    if (bookReportCharterEchoMatches(query, filters)) return;
    void reportError(new Error('book_order_totals answer is for another charter'), {
      tag,
      organizationId: this.ctx.organizationId,
      extra: { check: 'charter_echo' },
    });
    throw new ServiceError('internal_error', 'answer is for another charter');
  }

  private selfCheckFailure(check: string): ServiceError {
    void reportError(new Error(`book_order_totals export self-check failed: ${check}`), {
      tag: 'reports.book_order_totals.export',
      organizationId: this.ctx.organizationId,
      extra: { check },
    });
    return new ServiceError('internal_error', `export self-check failed: ${check}`);
  }

  private parse<T>(fn: () => T, tag: string): T {
    try {
      return fn();
    } catch (e) {
      void reportError(e, { tag, organizationId: this.ctx.organizationId });
      throw new ServiceError(
        'internal_error',
        e instanceof Error ? e.message : 'unreadable answer',
      );
    }
  }
}
