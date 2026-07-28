'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

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
});

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

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const raw = parsed.data.rows[i] ?? {};
      const validated = csvRowSchema.safeParse(raw);
      if (!validated.success) {
        summary.failed++;
        summary.errors.push({ row: i + 2, message: validated.error.issues[0]?.message ?? 'Invalid row' });
        continue;
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
