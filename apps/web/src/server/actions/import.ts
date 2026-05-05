'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import { err, ok, type ActionResult } from '@stockpilot/core';

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
  location_name: z.string().max(120).optional(),
  supplier_name: z.string().max(120).optional(),
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
    const svc = await InventoryService.forCurrentUser();
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
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
