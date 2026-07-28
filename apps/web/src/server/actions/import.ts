'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { assertPermission, planLimitBudget, ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import {
  ItemImportBatchesService,
  type ItemImportDuplicate,
} from '@/server/services/item-imports';
import { WarehousesService } from '@/server/services/warehouses';

import {
  AMBIGUOUS_COLUMN_MEANINGS,
  applyItemCsvHeaderDecisions,
  emptyToUndefined,
  err,
  itemCsvHeaderDecisionsOutstanding,
  jerseyNumberSchema,
  ok,
  resolveItemCsvHeaders,
  reviewItemCsvRows,
  sizeSystemSchema,
  type ActionResult,
  type AmbiguousColumnMeaning,
  type CsvHeaderMapping,
  type ItemCsvReviewRow,
} from '@stockpilot/core';

const csvRowSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(64).optional(),
  barcode: z.string().max(128).optional(),
  description: z.string().max(5000).optional(),
  unit_cost: z.coerce.number().nonnegative().default(0),
  retail_price: z.coerce.number().nonnegative().default(0),
  quantity_on_hand: z.coerce.number().default(0),
  reorder_point: z.coerce.number().nonnegative().default(0),
  reorder_quantity: z.coerce.number().nonnegative().default(0),
  unit_of_measure: z.string().max(32).optional(),
  category_name: z.string().max(120).optional(),
  subcategory_name: z.string().max(120).optional(),
  location_name: z.string().max(120).optional(),
  warehouse_name: z.string().max(120).optional(),
  supplier_name: z.string().max(120).optional(),

  // ── Sports columns (Task 13) ──────────────────────────────────────────────
  // The VARIANT block below is applied to the created item. It reuses the
  // shared core schemas rather than re-declaring the rules, so a CSV, the web
  // form and Expo all accept exactly the same values — including
  // jerseyNumberSchema's leading-zero preservation ('07' stays '07', and a
  // '12A' is REJECTED with a row error rather than imported wrong).
  size: z.preprocess(emptyToUndefined, z.string().max(24).optional()),
  // Case-folded before the shared enum sees it: a spreadsheet cell reading
  // "us_mens" is unambiguous, and failing the row over its case would be a
  // pointless rejection. The VALUE set is still the shared one — this widens
  // nothing, it only normalizes the way the AI extractor already does.
  size_system: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    sizeSystemSchema,
  ),
  width: z.preprocess(emptyToUndefined, z.string().max(16).optional()),
  fit: z.preprocess(emptyToUndefined, z.string().max(32).optional()),
  color: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
  jersey_number: jerseyNumberSchema,
  player_name: z.preprocess(emptyToUndefined, z.string().max(120).optional()),

  // The GROUP-IDENTITY block. Accepted and bounded here so a template row
  // carrying them is not a validation failure, but deliberately NOT applied:
  // creating product groups from a CSV is bulk identity creation, and the
  // owner decision is that families link through the review tool, never a
  // heuristic import ("NO name-heuristic auto-backfill"). Task 18's linking
  // tool is what consumes these.
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  style_number: z.string().max(64).optional(),
  colorway: z.string().max(64).optional(),
  team: z.string().max(120).optional(),
  season: z.string().max(32).optional(),
  home_away: z.string().max(16).optional(),
  counting_unit: z.string().max(32).optional(),
  tracking_mode: z.string().max(32).optional(),
  serial: z.string().max(128).optional(),
  asset_tag: z.string().max(128).optional(),
});

/**
 * The header-mapping answers, keyed by the header EXACTLY as the file printed
 * it. Bounded to Task 14's vocabulary so a client cannot post an arbitrary
 * string and have it treated as an answer.
 */
const headerDecisionsSchema = z
  .record(z.string().max(200), z.enum(AMBIGUOUS_COLUMN_MEANINGS))
  .optional();

const reviewInputSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
  /**
   * The file's header row, in order. Optional: derived from the union of row
   * keys when absent, which keeps every pre-existing caller (and a hand-built
   * payload) working exactly as it did.
   */
  headers: z.array(z.string().max(200)).max(200).optional(),
  headerDecisions: headerDecisionsSchema,
  fileName: z.string().max(255).optional(),
});

const importSchema = reviewInputSchema.extend({
  /**
   * The import screen's destination picker — the whole file's default
   * warehouse. `InventoryService.create()` has refused to create an item
   * without a warehouse since d4550449 and this action never sent one, so every
   * CSV row failed with "A warehouse must be selected before creating an item."
   * for any user who was not warehouse-SCOPED (a scoped user's
   * `forcedWarehouseId` supplies one inside create() regardless of input, which
   * is why this survived unnoticed).
   *
   * Optional, not required: leaving it out must keep deferring to
   * `forcedWarehouseId`, so a scoped user's import is unchanged and the action
   * never invents an id of its own.
   */
  warehouseId: z.string().uuid().optional(),
  /**
   * The explicit override for a same-file re-upload. Never defaulted to true:
   * the whole point of the warning is that a human decides this file really is
   * a second, intentional import rather than a double-click.
   */
  acknowledgeDuplicate: z.boolean().optional(),
});

/**
 * ONE resolution of "what do this file's columns mean", shared by the review
 * action and the write action.
 *
 * Both the sports gate and the header mapping are resolved from the SERVER's
 * context, never from the payload: a review step a client can skip by posting
 * straight to the action is not a block, and a module gate the client asserts
 * is not a gate.
 */
function resolveMapping(
  ctx: { enabledModules?: Set<string> },
  input: { rows: Array<Record<string, string>>; headers?: string[]; headerDecisions?: Record<string, AmbiguousColumnMeaning> },
): {
  sportsEnabled: boolean;
  mappings: CsvHeaderMapping[];
  unresolvedHeaders: string[];
  decisions: Record<string, AmbiguousColumnMeaning>;
} {
  const sportsEnabled = ctx.enabledModules?.has('sports') ?? false;
  // Header order is preserved when the screen sends it. Falling back to the
  // union of row keys keeps a hand-built payload (and every pre-existing test)
  // resolving exactly the same columns.
  const headers =
    input.headers && input.headers.length > 0
      ? input.headers
      : [...new Set(input.rows.flatMap((r) => Object.keys(r)))];
  const decisions = input.headerDecisions ?? {};
  const mappings = resolveItemCsvHeaders(headers, { sportsEnabled });
  return {
    sportsEnabled,
    mappings,
    unresolvedHeaders: itemCsvHeaderDecisionsOutstanding(mappings, decisions),
    decisions,
  };
}

export interface ItemImportPreview {
  sportsEnabled: boolean;
  mappings: CsvHeaderMapping[];
  /** Headers a human must still answer. Non-empty ⇒ Import stays blocked. */
  unresolvedHeaders: string[];
  rows: ItemCsvReviewRow[];
  /** The live batch for this exact file, when there is one. */
  duplicate: ItemImportDuplicate | null;
}

/**
 * The review step: what WOULD happen, computed without writing anything.
 *
 * LIVE-VERIFIED FAIL (report line 10a): the review table printed the file's own
 * first eight raw headers with "no Group column, no Variant column, and no
 * per-row Result column". Requirements: a review row states what will happen,
 * "Not just Valid/Invalid".
 *
 * Deliberately derived on the server from the same functions the write uses, so
 * the table can never show one verdict and the import perform another.
 */
export async function prepareItemImportAction(
  input: z.infer<typeof reviewInputSchema>,
): Promise<ActionResult<ItemImportPreview>> {
  const parsed = reviewInputSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');

  try {
    const ctx = await withContext();
    assertPermission(ctx, 'items:import');
    const { sportsEnabled, mappings, unresolvedHeaders, decisions } = resolveMapping(
      ctx,
      parsed.data,
    );
    const duplicate = await new ItemImportBatchesService(ctx).findLiveBatch(
      ItemImportBatchesService.fingerprint(parsed.data.rows),
    );
    return ok({
      sportsEnabled,
      mappings,
      unresolvedHeaders,
      rows: reviewItemCsvRows(parsed.data.rows, mappings, {
        sportsEnabled,
        headerDecisions: decisions,
      }),
      duplicate,
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Case- and whitespace-insensitive lookup of the template's own
 * `warehouse_name` column against the org's ACTIVE warehouses. Built once per
 * file, and only when a row actually names one.
 *
 * A name that matches two warehouses maps to `null` rather than to either of
 * them: picking one would silently put stock in the wrong building, and that is
 * exactly the kind of quiet mis-write the row error below exists to prevent.
 */
function indexWarehousesByName(
  warehouses: ReadonlyArray<{ id: string; name: string }>,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const w of warehouses) {
    const key = w.name.trim().toLowerCase();
    index.set(key, index.has(key) ? null : w.id);
  }
  return index;
}

export /**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * `limit` workers each pull the next index off a shared cursor, so a slow row
 * never blocks the queue behind it. `fn` must swallow its own errors — a
 * rejection here would abandon the remaining rows, and a half-imported file
 * with no per-row report is worse than a slow one.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

export interface ImportSummary {
  total: number;
  created: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

export async function importItemsAction(input: z.infer<typeof importSchema>): Promise<ActionResult<ImportSummary>> {
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');

  try {
    const ctx = await withContext();
    assertPermission(ctx, 'items:import');

    // ── Gate 1: no column may be guessed ────────────────────────────────────
    // Enforced HERE, not only in the screen. "Block import until required
    // mappings resolved" is a property of the write, and an answer that was
    // never offered for that header (a forged 'line_number', or a sports
    // meaning in a non-sports org) counts as no answer at all.
    const { mappings, unresolvedHeaders, decisions } = resolveMapping(ctx, parsed.data);
    if (unresolvedHeaders.length > 0) {
      return err(
        'validation_error',
        `Confirm what ${unresolvedHeaders.map((h) => `"${h}"`).join(', ')} ${
          unresolvedHeaders.length === 1 ? 'means' : 'mean'
        } before importing. A column headed something like "Number" could be a jersey number, a quantity, a serial or a style number, and this import will not guess.`,
      );
    }

    // ── Gate 2: the same file, twice ────────────────────────────────────────
    const batches = new ItemImportBatchesService(ctx);
    const fingerprint = ItemImportBatchesService.fingerprint(parsed.data.rows);
    const duplicate = await batches.findLiveBatch(fingerprint);
    if (duplicate && !parsed.data.acknowledgeDuplicate) {
      return err(
        'conflict',
        `This same file was already imported on ${new Date(duplicate.importedAt).toLocaleDateString()} and created ${duplicate.createdCount} item${duplicate.createdCount === 1 ? '' : 's'}. Importing it again will create them a second time. Confirm on the review screen if that is what you want.`,
      );
    }

    // Claimed BEFORE the rows are written: a crash mid-import must not leave
    // the file unfingerprinted, or the retry doubles everything that landed.
    const batchId = await batches.claim({
      sha256: fingerprint,
      fileName: parsed.data.fileName ?? null,
      rowCount: parsed.data.rows.length,
      supersedePredecessors: Boolean(duplicate),
    });

    // ONE service instance for the whole file, deliberately: its per-instance
    // `trackingProfiles` memo is what stops every row re-reading the same
    // category, and a fresh instance per row would defeat it.
    const svc = new InventoryService(ctx);
    const summary: ImportSummary = { total: parsed.data.rows.length, created: 0, failed: 0, errors: [] };

    // Hoisted out of the row loop: the (user, org) tuple is fixed for the whole
    // file, so one read serves 5,000 rows. Skipped entirely when no row names a
    // warehouse, which is the ordinary case — the screen's picker covers it.
    const namesWanted = parsed.data.rows.some((r) => (r?.warehouse_name ?? '').trim() !== '');
    const [warehouseIdByName, planBudget] = await Promise.all([
      namesWanted
        ? indexWarehousesByName(await new WarehousesService(ctx).listNames())
        : Promise.resolve(new Map<string, string | null>()),
      // OWNER, live prod: "took very long to import needs to be faster" — four
      // rows. The plan gate inside `create()` is two reads (the org's plan, then
      // a COUNT over inventory_items), and it ran ONCE PER ROW: eight reads to
      // answer the same question four times, serially, before a single item was
      // written. Resolved once here, spent per row below. Same check, same
      // refusal, same message — the reads are what move.
      planLimitBudget(ctx, 'items'),
    ]);

    // ── Pass 1: validate and resolve every row, in order, no I/O ────────────
    // Pure CPU, so it stays a plain loop and `summary.errors` keeps its file
    // order. Only the rows that survive reach the concurrent write pass.
    interface PlannedRow {
      /** 1-based source row as the user sees it in their spreadsheet. */
      sourceRow: number;
      input: Parameters<InventoryService['create']>[0];
    }
    const planned: PlannedRow[] = [];
    const rowErrors = new Map<number, string>();

    for (let i = 0; i < parsed.data.rows.length; i++) {
      // The confirmed mapping is what lands: an aliased header ("Qty") fills
      // its template column, and a confirmed ambiguous header ("Number") goes
      // to the field the human named — or, on 'ignore', to no field at all.
      // The source value is preserved under its own header either way.
      const raw = applyItemCsvHeaderDecisions(parsed.data.rows[i] ?? {}, mappings, decisions);
      const validated = csvRowSchema.safeParse(raw);
      if (!validated.success) {
        rowErrors.set(i + 2, validated.error.issues[0]?.message ?? 'Invalid row');
        continue;
      }
      // Per-row override, org-scoped by construction: the index only ever holds
      // warehouses this org can see, so a name from another tenant simply does
      // not resolve. A row that names one and gets it wrong fails ON ITS OWN —
      // the rest of the file still imports.
      const namedWarehouse = validated.data.warehouse_name?.trim();
      let rowWarehouseId = parsed.data.warehouseId;
      if (namedWarehouse) {
        if (!warehouseIdByName.has(namedWarehouse.toLowerCase())) {
          rowErrors.set(
            i + 2,
            `No active warehouse named "${namedWarehouse}" in this organization. Use the exact name from Warehouses, or clear the warehouse_name cell to use the destination picked above.`,
          );
          continue;
        }
        const match = warehouseIdByName.get(namedWarehouse.toLowerCase()) ?? null;
        if (!match) {
          rowErrors.set(
            i + 2,
            `More than one active warehouse is named "${namedWarehouse}", so this row could go to either. Rename one of them, or clear the warehouse_name cell to use the destination picked above.`,
          );
          continue;
        }
        rowWarehouseId = match;
      }
      planned.push({
        sourceRow: i + 2,
        input: {
          name: validated.data.name,
          sku: validated.data.sku,
          barcode: validated.data.barcode,
          description: validated.data.description,
          unitCost: validated.data.unit_cost,
          retailPrice: validated.data.retail_price,
          quantityOnHand: validated.data.quantity_on_hand,
          reorderPoint: validated.data.reorder_point,
          reorderQuantity: validated.data.reorder_quantity,
          unitOfMeasure: validated.data.unit_of_measure ?? 'unit',
          categoryId: null,
          supplierId: null,
          primaryLocationId: null,
          // Undefined, never null, when nothing resolved: create() reads
          // `forced ?? input.warehouseId ?? null`, so a warehouse-scoped user's
          // assignment still wins and an unscoped user still gets the original
          // "A warehouse must be selected" error rather than a silent write.
          warehouseId: rowWarehouseId,
          trackingType: 'none',
          itemType: 'product',
          customFields: {},
          status: 'active',
          // Sports variant attributes (Task 13). Passed straight to the
          // service, which is where the category's tracking profile decides
          // whether they are allowed — the CSV is never the authority. A
          // non-sports row leaves every one undefined and creates exactly the
          // item it created before.
          variantSize: validated.data.size,
          variantSizeOriginal: validated.data.size,
          variantSizeSystem: validated.data.size_system,
          variantWidth: validated.data.width,
          variantFit: validated.data.fit,
          variantColor: validated.data.color,
          jerseyNumber: validated.data.jersey_number,
          playerName: validated.data.player_name,
        },
      });
    }

    // ── Pass 2: write the surviving rows, a few at a time ───────────────────
    // These used to run strictly one after another, so the file's wall clock
    // was the SUM of every row's round trips — and a row's round trips are
    // almost all latency, not work. Nothing here is order-dependent: each row
    // is its own insert, the rows share no state but the (synchronous) plan
    // budget and the service's read caches, and the CSV path never touches
    // product-group find-or-create (it passes `categoryId: null`, so
    // `profile.isSports` is false and the group block is unreachable) — which
    // is the one place in create() a race could mint a duplicate. Even there,
    // `ProductGroupsService.findOrCreate` converges on a 23505 by re-reading
    // the winner's row, the behaviour Task 15 proved.
    //
    // Bounded, not unbounded: 5,000 rows fired at once would exhaust the
    // connection pool and defeat the point. Six is comfortably under Supabase's
    // per-request pooling and keeps a small file's cost at roughly one row's.
    const CONCURRENCY = 6;

    /** Writes one planned row. Returns false when the plan had no slot for it —
     *  the caller decides whether that is final. */
    const writeRow = async (row: PlannedRow): Promise<boolean> => {
      // Reserved BEFORE the write and released if the write fails, so the
      // headroom always reflects rows that actually landed — exactly what the
      // per-row COUNT used to report, without the COUNT.
      const slot = planBudget.take(1);
      if (!slot) return false;
      try {
        // ONLY `planSlot` is added here. `source: 'import'` would be the
        // truthful provenance for the audit trail, but this action has never
        // sent it, and switching a shipped audit label is not this change's
        // business. (It is inert on this path either way: the CSV always passes
        // `categoryId: null` and no group, so `variant_key` stays null and the
        // variant-provenance audit never fires. Noted, not fixed.)
        await svc.create(row.input, { planSlot: slot });
      } catch (e) {
        slot.release();
        rowErrors.set(row.sourceRow, e instanceof Error ? e.message : 'Unknown error');
      }
      return true;
    };

    // ── The plan limit is enforced HERE and nowhere else ────────────────────
    // Nothing in the database rejects an over-limit item: there is no trigger,
    // no check constraint, no unique index standing behind a plan tier. So a
    // budget read once and then spent across a whole file is not just stale, it
    // is the only thing between two simultaneous imports and double the org's
    // allowance — each request would snapshot the same `limit - used` and both
    // would happily spend it.
    //
    // So the file is written in BATCHES of `CONCURRENCY`, and the count is
    // re-read between them. One extra COUNT per six rows is negligible next to
    // the six inserts it guards, and it means a second import running alongside
    // this one becomes visible within one batch instead of never.
    //
    // RESIDUAL, stated rather than hidden: within a single batch, up to
    // `CONCURRENCY` rows can be reserved against a count that a concurrent
    // request is already invalidating — two imports that both refresh at the
    // same count with headroom equal to the batch width each write a full
    // batch, so the worst-case joint overshoot is one batch (6 items) before
    // the next refresh sees it. That is the same check-then-insert class the
    // shipped serial code had — its window was one row instead of a batch —
    // and closing it properly needs DB-level enforcement, which does not
    // exist for plan limits today.
    for (let start = 0; start < planned.length; start += CONCURRENCY) {
      // Between batches only, and with nothing in flight — `refresh()` rebases
      // on a count that already includes this request's own inserts, so an
      // outstanding reservation would be double-counted.
      if (start > 0) await planBudget.refresh();

      // The plan filled up — either from our own rows or someone else's. No
      // later row can fit, so stop asking and refuse the remainder in one go
      // rather than making a COUNT per batch for the rest of a 5,000-row file.
      if (planBudget.isFull()) {
        for (const row of planned.slice(start)) {
          rowErrors.set(row.sourceRow, planBudget.exceeded().message);
        }
        break;
      }

      const batch = planned.slice(start, start + CONCURRENCY);

      // Rows the budget had no room for WHILE siblings were still in flight.
      // Not an error yet: a row that reserved a slot and then failed its insert
      // gives that slot back, and under concurrency it can give it back after a
      // later row was already turned away. The old serial loop could not see
      // that ordering, so treating "no room right now" as final here would
      // refuse rows the shipped code imported. They get one more look below,
      // once every release in this batch has landed.
      const deferred: PlannedRow[] = [];
      await runWithConcurrency(batch, CONCURRENCY, async (row) => {
        if (!(await writeRow(row))) deferred.push(row);
      });

      // Deliberately SERIAL and in file order: this is the plan boundary, where
      // each row's outcome decides the next row's headroom. That is precisely
      // the shipped loop's shape, so the file fills to the limit the same way it
      // always did — the concurrency above is an optimisation for the ordinary
      // case, never a change to who gets in.
      for (const row of deferred.sort((a, b) => a.sourceRow - b.sourceRow)) {
        if (!(await writeRow(row))) {
          rowErrors.set(row.sourceRow, planBudget.exceeded().message);
        }
      }
    }

    // Folded in FILE order, never completion order: a user reads these against
    // their spreadsheet, so row 7 must come after row 3 however they finished.
    summary.failed = rowErrors.size;
    summary.created = summary.total - summary.failed;
    for (const sourceRow of [...rowErrors.keys()].sort((a, b) => a - b)) {
      summary.errors.push({ row: sourceRow, message: rowErrors.get(sourceRow) as string });
    }

    await batches.recordOutcome(batchId, {
      createdCount: summary.created,
      failedCount: summary.failed,
    });
    // A batch that created NOTHING has nothing to double, so it must not stand
    // between the user and the corrected re-upload. Without this, the exact
    // failure the live run hit (0 created / 4 failed) would have left a
    // duplicate warning on the fixed file's very next attempt.
    if (summary.created === 0) await batches.release(batchId);

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
