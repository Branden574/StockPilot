'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { WarehousesService } from '@/server/services/warehouses';

import {
  emptyToUndefined,
  err,
  jerseyNumberSchema,
  ok,
  sizeSystemSchema,
  type ActionResult,
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

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
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
});

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

interface ImportSummary {
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
    const svc = new InventoryService(ctx);
    const summary: ImportSummary = { total: parsed.data.rows.length, created: 0, failed: 0, errors: [] };

    // Hoisted out of the row loop: the (user, org) tuple is fixed for the whole
    // file, so one read serves 5,000 rows. Skipped entirely when no row names a
    // warehouse, which is the ordinary case — the screen's picker covers it.
    const namesWanted = parsed.data.rows.some((r) => (r?.warehouse_name ?? '').trim() !== '');
    const warehouseIdByName = namesWanted
      ? indexWarehousesByName(await new WarehousesService(ctx).listNames())
      : new Map<string, string | null>();

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const raw = parsed.data.rows[i] ?? {};
      const validated = csvRowSchema.safeParse(raw);
      if (!validated.success) {
        summary.failed++;
        summary.errors.push({ row: i + 2, message: validated.error.issues[0]?.message ?? 'Invalid row' });
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
          summary.failed++;
          summary.errors.push({
            row: i + 2,
            message: `No active warehouse named "${namedWarehouse}" in this organization. Use the exact name from Warehouses, or clear the warehouse_name cell to use the destination picked above.`,
          });
          continue;
        }
        const match = warehouseIdByName.get(namedWarehouse.toLowerCase()) ?? null;
        if (!match) {
          summary.failed++;
          summary.errors.push({
            row: i + 2,
            message: `More than one active warehouse is named "${namedWarehouse}", so this row could go to either. Rename one of them, or clear the warehouse_name cell to use the destination picked above.`,
          });
          continue;
        }
        rowWarehouseId = match;
      }
      try {
        await svc.create({
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
        });
        summary.created++;
      } catch (e) {
        summary.failed++;
        summary.errors.push({
          row: i + 2,
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
