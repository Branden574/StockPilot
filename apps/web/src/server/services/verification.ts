import 'server-only';

import {
  formatOccurrenceNumber,
  locationRecountProblem,
  locationVerificationTotals,
  resolveOrgTimezone,
  type ItemVerificationSummary,
  type LocationVerificationTotals,
  type RecountUnavailableReason,
  type VerificationIssue,
  type VerificationLastCount,
  type VerificationPerson,
} from '@stockpilot/core';

import { chunkInFilterValues, mapWithConcurrency } from '@/lib/supabase/in-filter';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { personFor } from './exception-occurrences';
import { countStartBlock } from './lib/count-start-preflight';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';
import { postgrestErrorText } from './lib/postgrest-error';

/**
 * VERIFICATION SUMMARIES (F1-3, migration 0374): "last physical count" for an
 * item (the item card, the occurrence detail) and for every item held at a
 * location (the location page), on the web and, through
 * GET /api/v1/items/[id]/verification and GET /api/v1/locations/[id]/verification,
 * on the phone. Core verificationSummaryCopy words it the same on both.
 *
 * WHERE THE FACTS COME FROM. item_verification_summaries (0374), called with
 * the READER's client: it answers only for items the reader can read, and
 * reads the counts and movements past RLS itself (SECURITY DEFINER, gated in
 * its body), so a reader who cannot see an item's movements still gets the
 * true number. It answers at most 500 items per call; every caller here goes
 * through summaries(), which batches.
 *
 * WHAT A FAILED READ LOOKS LIKE. Every read that feeds what the page SAYS
 * (the summary, the holdings, the open issues, the "checked at") throws, and
 * the caller shows "Couldn't load verification". None of them is ever turned
 * into an empty answer: an empty summary reads as "never counted", an empty
 * holdings list as "nothing here", no issues as "nothing wrong". Only the
 * org's time zone (a formatting choice) and the counter's and poster's names
 * (left out of the words when unreadable) degrade.
 *
 * WHO. items:read, checked first (with the MFA step-up), exactly as the
 * Exception Center: the summaries are item facts, and the database floor is
 * caller_can_read_item. No module gate: a count's history stays readable when
 * Cycle Counts is turned off. Starting a count is a separate permission,
 * reported as canCount / canRecount (countStartBlock), never assumed.
 */

/** item_verification_summaries' own cap (22023 too_many_items above it). It
 *  also keeps one answer under PostgREST's 1000-row max_rows. */
export const VERIFICATION_BATCH_SIZE = 500;
/** Batches in flight at once for one page. */
const VERIFICATION_BATCH_CONCURRENCY = 2;
/** Rows a location page shows at a time. */
export const LOCATION_VERIFICATION_PAGE_SIZE = 50;
/** Holdings read for one location. Far above any real location; reaching it
 *  is disclosed (`truncated`), never silent. */
export const LOCATION_HOLDINGS_CAP = 20_000;
/** Open exceptions read for one item or one location (a backstop). */
const ISSUES_CAP = 1_000;

// ── Shapes (the API returns these as JSON) ──────────────────────────────────

/** An open exception as a chip: core verificationIssueChipCopy words it. */
export interface VerificationIssueRef extends VerificationIssue {
  /** "EX-000042". */
  reference: string | null;
  itemId: string;
}

export interface ItemVerification {
  itemId: string;
  summary: ItemVerificationSummary;
  /** Open exceptions about this item (any location), under the reader's RLS. */
  openIssues: VerificationIssueRef[];
  openIssuesTruncated: boolean;
  /** When the exceptions were last checked (null before the org's first
   *  check: never read as "no issues"). */
  checkedAt: string | null;
  /** The reader may start a count ("Count this item"); the item itself must
   *  also be countable (summary.item.countable). */
  canCount: boolean;
  countUnavailableReason: RecountUnavailableReason | null;
  timeZone: string;
}

export interface LocationVerificationRow {
  itemId: string;
  name: string;
  sku: string | null;
  /** Units of this item at this location. */
  quantity: number;
  /** Null: the summary could not be matched to the item (worded as
   *  "Couldn't load verification", never "Not counted"). */
  summary: ItemVerificationSummary | null;
  /** Open exceptions about this item here, or about the item itself. */
  issues: VerificationIssueRef[];
}

export interface LocationVerification {
  location: {
    id: string;
    name: string;
    kind: string | null;
    type: string | null;
    warehouseId: string | null;
    warehouseName: string | null;
    archived: boolean;
  };
  /**
   * False when the reader's warehouses do not cover this location
   * (location_holdings_visible, 0374: item_stock_levels RLS hides every
   * holding here). `rows` is then empty and `totals` null; the page says
   * LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY, never "nothing here".
   */
  holdingsVisible: boolean;
  /** Open exceptions recorded at this location. */
  openIssues: VerificationIssueRef[];
  openIssuesTruncated: boolean;
  /** This page of rows, sorted by item name. */
  rows: LocationVerificationRow[];
  page: number;
  pageSize: number;
  pageCount: number;
  totalRows: number;
  /** Across EVERY row, not just this page. */
  totals: LocationVerificationTotals | null;
  /** The holdings read stopped at LOCATION_HOLDINGS_CAP: totals are partial. */
  truncated: boolean;
  checkedAt: string | null;
  /** The reader may start a recount ("Recount items here"). */
  canRecount: boolean;
  recountUnavailableReason: RecountUnavailableReason | null;
  /** Why "Recount items here" cannot be pressed for this location's items
   *  (none countable, or more than the recount cap), or null. */
  recountProblem: string | null;
  timeZone: string;
}

// ── Row mapping ─────────────────────────────────────────────────────────────

/** A row of item_verification_summaries as PostgREST returns it (numeric may
 *  arrive as a string when large). */
export type SummaryRow = {
  item_id: string;
  item_status: string | null;
  item_is_rental: boolean | null;
  item_is_bundle: boolean | null;
  item_deleted: boolean | null;
  item_countable: boolean | null;
  quantity_on_hand: number | string | null;
  cycle_count_id: string | null;
  count_number: number | string | null;
  scope: string | null;
  completed_at: string | null;
  completed_by: string | null;
  counted_by: string | null;
  counted_at: string | null;
  captured_at: string | null;
  baseline_at: string | null;
  expected_quantity: number | string | null;
  expected_at_start: number | string | null;
  counted_quantity: number | string | null;
  counted_location_id: string | null;
  counted_location_name: string | null;
  counted_location_kind: string | null;
  counted_location_archived: boolean | null;
  ai_assisted: boolean | null;
  movements_since: number | string | null;
  outside_ledger_since: number | string | null;
  open_count_id: string | null;
  open_count_number: number | string | null;
};

function quantityOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function wholeOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** People start unnamed; item() names them. */
function unnamed(id: string | null): VerificationPerson | null {
  return id ? { id, label: null } : null;
}

export function mapSummaryRow(row: SummaryRow): ItemVerificationSummary {
  const lastCount: VerificationLastCount | null = row.cycle_count_id
    ? {
        cycleCountId: row.cycle_count_id,
        countNumber: wholeOf(row.count_number),
        completedAt: row.completed_at,
        countedAt: row.counted_at,
        capturedAt: row.captured_at,
        baselineAt: row.baseline_at,
        expectedQuantity: quantityOf(row.expected_quantity),
        expectedAtStart: quantityOf(row.expected_at_start),
        countedQuantity: quantityOf(row.counted_quantity),
        countedLocationId: row.counted_location_id,
        countedLocation: row.counted_location_id
          ? {
              name: row.counted_location_name,
              kind: row.counted_location_kind,
              archived: row.counted_location_archived === true,
            }
          : null,
        aiAssisted: row.ai_assisted === true,
        countedBy: unnamed(row.counted_by),
        postedBy: unnamed(row.completed_by),
      }
    : null;
  return {
    itemId: row.item_id,
    item: {
      status: row.item_status,
      isRental: row.item_is_rental === true,
      isBundle: row.item_is_bundle === true,
      deleted: row.item_deleted === true,
      countable: row.item_countable === true,
      quantityOnHand: quantityOf(row.quantity_on_hand),
    },
    lastCount,
    movementsSince: lastCount ? wholeOf(row.movements_since) : null,
    outsideLedgerSince: lastCount ? wholeOf(row.outside_ledger_since) : null,
    openCount: row.open_count_id
      ? { cycleCountId: row.open_count_id, countNumber: wholeOf(row.open_count_number) }
      : null,
  };
}

type IssueRow = {
  id: string;
  occurrence_number: number | string | null;
  rule: string;
  item_id: string;
  location_id: string | null;
};

const ISSUE_SELECT = 'id, occurrence_number, rule, item_id, location_id';

function mapIssue(row: IssueRow): VerificationIssueRef {
  const number = wholeOf(row.occurrence_number);
  return {
    id: row.id,
    number,
    reference: formatOccurrenceNumber(number),
    rule: row.rule,
    itemId: row.item_id,
    locationId: row.location_id,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Service ─────────────────────────────────────────────────────────────────

export class VerificationService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<VerificationService> {
    return new VerificationService(await withContext());
  }

  /**
   * Summaries for any number of items, keyed by item id, in batches of
   * VERIFICATION_BATCH_SIZE through the reader's client. An item the reader
   * cannot read (or one outside the org) has no entry. Any failed batch
   * throws: a partial map would leave some items reading as unsummarised.
   */
  async summaries(itemIds: readonly string[]): Promise<Map<string, ItemVerificationSummary>> {
    assertPermission(this.ctx, 'items:read');
    const batches = chunkInFilterValues(itemIds, {
      maxValues: VERIFICATION_BATCH_SIZE,
      maxEncodedChars: Number.POSITIVE_INFINITY,
    });
    const orgId = this.ctx.organizationId;
    const results = await mapWithConcurrency(
      batches,
      VERIFICATION_BATCH_CONCURRENCY,
      async (batch) => {
        // A POST: the ids travel in the body, never the URL.
        const res = await this.ctx.supabase.rpc('item_verification_summaries', {
          p_org: orgId,
          p_item_ids: batch,
        });
        if (res.error) {
          throw new ServiceError('internal_error', postgrestErrorText(res.error, res));
        }
        if (!Array.isArray(res.data)) {
          throw new ServiceError(
            'internal_error',
            'item_verification_summaries returned no rows array',
          );
        }
        return res.data as SummaryRow[];
      },
    );
    const out = new Map<string, ItemVerificationSummary>();
    for (const rows of results) for (const row of rows) out.set(row.item_id, mapSummaryRow(row));
    return out;
  }

  /**
   * One item's verification: its summary (with the counter's and poster's
   * names), its open exceptions and when they were last checked, and whether
   * the reader may start a count. `not_found` when the item does not exist,
   * is in another org, or is not readable to this reader (existence is not
   * leaked).
   */
  async item(itemId: string): Promise<ItemVerification> {
    assertPermission(this.ctx, 'items:read');
    if (!UUID.test(itemId)) {
      throw new ServiceError('validation_error', 'That item id is not valid.', {
        reason: 'invalid_item_id',
      });
    }
    const orgId = this.ctx.organizationId;
    const [summaries, issues, checkedAt, timeZone] = await Promise.all([
      this.summaries([itemId]),
      fetchAllRows<IssueRow>(
        (from, to) =>
          this.ctx.supabase
            .from('exception_occurrences')
            .select(ISSUE_SELECT)
            .eq('organization_id', orgId)
            .eq('item_id', itemId)
            .is('resolved_at', null)
            .order('occurrence_number', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: IssueRow[] | null;
            error: { message: string } | null;
          }>,
        { cap: ISSUES_CAP },
      ),
      this.readCheckedAt(),
      this.readOrgTimeZone(),
    ]);
    const summary = summaries.get(itemId);
    if (!summary) throw new ServiceError('not_found', 'That item was not found.');
    const named = await this.nameCountPeople(summary);
    const block = countStartBlock(this.ctx);
    return {
      itemId,
      summary: named,
      openIssues: issues.map(mapIssue),
      openIssuesTruncated: issues.length >= ISSUES_CAP,
      checkedAt,
      canCount: block === null,
      countUnavailableReason: block,
      timeZone,
    };
  }

  /**
   * One location's verification page: the location, the open exceptions
   * recorded there, and every holding of an item the reader can open with
   * that item's summary, paged LOCATION_VERIFICATION_PAGE_SIZE at a time.
   *
   * The holdings are read in full (fetchAllRows) and summarised in
   * VERIFICATION_BATCH_SIZE batches so `totals` cover every row, not the page.
   * Holdings of items the reader cannot open are counted (hiddenItems), not
   * listed. When the reader's warehouses do not cover the location at all,
   * nothing is listed and `holdingsVisible` is false.
   */
  async location(locationId: string, opts: { page?: number } = {}): Promise<LocationVerification> {
    assertPermission(this.ctx, 'items:read');
    if (!UUID.test(locationId)) {
      throw new ServiceError('validation_error', 'That location id is not valid.', {
        reason: 'invalid_location_id',
      });
    }
    const orgId = this.ctx.organizationId;

    type LocationRow = {
      id: string;
      name: string;
      kind: string | null;
      type: string | null;
      warehouse_id: string | null;
      deleted_at: string | null;
      warehouse?: { name: string | null } | null;
    };
    type HoldingRow = {
      id: string;
      item_id: string;
      quantity: number | string;
      item?: { id: string; name: string; sku: string | null } | null;
    };

    const [locationRes, visibleRes, holdings, openHere, checkedAt, timeZone] = await Promise.all([
      this.ctx.supabase
        .from('locations')
        .select(
          'id, name, kind, type, warehouse_id, deleted_at, warehouse:warehouses!locations_warehouse_id_fkey(name)',
        )
        .eq('organization_id', orgId)
        .eq('id', locationId)
        .maybeSingle(),
      this.ctx.supabase.rpc('location_holdings_visible', { p_location_id: locationId }),
      // Every holding here the reader's scope shows (item_stock_levels RLS is
      // location-based, so for a visible location that is all of them). The
      // item embed is LEFT: an item the reader cannot open comes back null and
      // is counted as hidden, not dropped from the totals.
      fetchAllRows<HoldingRow>(
        (from, to) =>
          this.ctx.supabase
            .from('item_stock_levels')
            .select(
              'id, item_id, quantity, item:inventory_items!item_stock_levels_item_id_fkey(id, name, sku)',
            )
            .eq('organization_id', orgId)
            .eq('location_id', locationId)
            .gt('quantity', 0)
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: HoldingRow[] | null;
            error: { message: string } | null;
          }>,
        { cap: LOCATION_HOLDINGS_CAP },
      ),
      fetchAllRows<IssueRow>(
        (from, to) =>
          this.ctx.supabase
            .from('exception_occurrences')
            .select(ISSUE_SELECT)
            .eq('organization_id', orgId)
            .eq('location_id', locationId)
            .is('resolved_at', null)
            .order('occurrence_number', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: IssueRow[] | null;
            error: { message: string } | null;
          }>,
        { cap: ISSUES_CAP },
      ),
      this.readCheckedAt(),
      this.readOrgTimeZone(),
    ]);

    if (locationRes.error) {
      throw new ServiceError('internal_error', postgrestErrorText(locationRes.error, locationRes));
    }
    const loc = locationRes.data as LocationRow | null;
    if (!loc) throw new ServiceError('not_found', 'That location was not found.');
    if (visibleRes.error) {
      throw new ServiceError('internal_error', postgrestErrorText(visibleRes.error, visibleRes));
    }
    if (typeof visibleRes.data !== 'boolean') {
      throw new ServiceError('internal_error', 'location_holdings_visible returned no answer');
    }
    const holdingsVisible = visibleRes.data;

    const block = countStartBlock(this.ctx);
    const base = {
      location: {
        id: loc.id,
        name: loc.name,
        kind: loc.kind ?? null,
        type: loc.type ?? null,
        warehouseId: loc.warehouse_id ?? null,
        warehouseName: loc.warehouse?.name ?? null,
        archived: loc.deleted_at !== null,
      },
      openIssues: openHere.map(mapIssue),
      openIssuesTruncated: openHere.length >= ISSUES_CAP,
      checkedAt,
      canRecount: block === null,
      recountUnavailableReason: block,
      timeZone,
      pageSize: LOCATION_VERIFICATION_PAGE_SIZE,
    };

    if (!holdingsVisible) {
      return {
        ...base,
        holdingsVisible: false,
        rows: [],
        page: 1,
        pageCount: 1,
        totalRows: 0,
        totals: null,
        truncated: false,
        recountProblem: null,
      };
    }

    let hiddenItems = 0;
    let hiddenQuantity = 0;
    const listed: Array<{ itemId: string; name: string; sku: string | null; quantity: number }> =
      [];
    for (const h of holdings) {
      const quantity = quantityOf(h.quantity) ?? 0;
      if (!h.item) {
        hiddenItems += 1;
        hiddenQuantity += quantity;
        continue;
      }
      listed.push({ itemId: h.item_id, name: h.item.name, sku: h.item.sku ?? null, quantity });
    }
    listed.sort((a, b) => {
      const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
      return byName !== 0 ? byName : a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
    });

    const summaries = await this.summaries(listed.map((r) => r.itemId));
    const all = listed.map((r) => ({ ...r, summary: summaries.get(r.itemId) ?? null }));
    const totals = locationVerificationTotals(all, locationId, {
      items: hiddenItems,
      quantity: hiddenQuantity,
    });

    const totalRows = all.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / LOCATION_VERIFICATION_PAGE_SIZE));
    const requested = Number.isSafeInteger(opts.page) ? (opts.page as number) : 1;
    const page = Math.min(Math.max(1, requested), pageCount);
    const slice = all.slice(
      (page - 1) * LOCATION_VERIFICATION_PAGE_SIZE,
      page * LOCATION_VERIFICATION_PAGE_SIZE,
    );

    // The page's chips: the item's exceptions here, or about the item itself.
    const pageIssues = await fetchAllRowsByIds<IssueRow>(
      slice.map((r) => r.itemId),
      (batch) => (from, to) =>
        this.ctx.supabase
          .from('exception_occurrences')
          .select(ISSUE_SELECT)
          .eq('organization_id', orgId)
          .in('item_id', batch)
          .is('resolved_at', null)
          .order('occurrence_number', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: IssueRow[] | null;
          error: { message: string } | null;
        }>,
    );
    const issuesByItem = new Map<string, VerificationIssueRef[]>();
    for (const row of pageIssues) {
      if (row.location_id !== null && row.location_id !== locationId) continue;
      const list = issuesByItem.get(row.item_id) ?? [];
      list.push(mapIssue(row));
      issuesByItem.set(row.item_id, list);
    }

    return {
      ...base,
      holdingsVisible: true,
      rows: slice.map((r) => ({ ...r, issues: issuesByItem.get(r.itemId) ?? [] })),
      page,
      pageCount,
      totalRows,
      totals,
      truncated: holdings.length >= LOCATION_HOLDINGS_CAP,
      recountProblem: locationRecountProblem(totals.countable),
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** exception_sync_state.last_synced_at: "Checked at" for the issue chips.
   *  Null before the org's first check. A failed read throws. */
  private async readCheckedAt(): Promise<string | null> {
    const { data, error } = await this.ctx.supabase
      .from('exception_sync_state')
      .select('last_synced_at')
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    return (data as { last_synced_at?: string | null } | null)?.last_synced_at ?? null;
  }

  /** The org's time zone; a formatting choice, so a failed read falls back. */
  private async readOrgTimeZone(): Promise<string> {
    try {
      const { data, error } = await this.ctx.supabase
        .from('organizations')
        .select('timezone')
        .eq('id', this.ctx.organizationId)
        .maybeSingle();
      if (error) return resolveOrgTimezone(null);
      return resolveOrgTimezone((data as { timezone?: string | null } | null)?.timezone ?? null);
    } catch {
      return resolveOrgTimezone(null);
    }
  }

  /**
   * The counter's and the poster's names as the reader sees them (a profile
   * the reader can no longer see is a former member, as everywhere else). A
   * failed read leaves both unnamed, so the words leave them out: a name is
   * never guessed, and "Former member" is never said of someone who is not.
   */
  private async nameCountPeople(
    summary: ItemVerificationSummary,
  ): Promise<ItemVerificationSummary> {
    const count = summary.lastCount;
    if (!count) return summary;
    const ids = [count.countedBy?.id, count.postedBy?.id].filter((v): v is string => !!v);
    if (ids.length === 0) return summary;
    type ProfileRow = { id: string; full_name: string | null; email: string | null };
    let profiles: ProfileRow[];
    try {
      const res = await this.ctx.supabase
        .from('user_profiles')
        .select('id, full_name, email')
        // in-list-bound: at most two ids, the counter and the poster.
        .in('id', Array.from(new Set(ids)));
      if (res.error) throw new Error(postgrestErrorText(res.error, res));
      profiles = (res.data ?? []) as ProfileRow[];
    } catch (err) {
      reportDegradedRead('verification.count_people_unavailable', err, { itemId: summary.itemId });
      return summary;
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const name = (person: VerificationPerson | null): VerificationPerson | null =>
      person?.id
        ? { id: person.id, label: personFor(person.id, byId.get(person.id) ?? null).label }
        : person;
    return {
      ...summary,
      lastCount: { ...count, countedBy: name(count.countedBy), postedBy: name(count.postedBy) },
    };
  }
}
