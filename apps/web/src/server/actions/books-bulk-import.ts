'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { generateSku } from '@/lib/utils';
import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

const bookSchema = z.object({
  isbn: z.string().min(10).max(13),
  title: z.string().min(1).max(280),
  author: z.string().max(280).nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  publisher: z.string().max(200).nullable().optional(),
  publishedDate: z.string().max(40).nullable().optional(),
  pageCount: z.number().int().nonnegative().nullable().optional(),
  grade: z.string().max(40).nullable().optional(),
  quantityOnHand: z.number().int().nonnegative().default(0),
  unitCost: z.number().nonnegative().default(0),
  retailPrice: z.number().nonnegative().default(0),
});

const inputSchema = z.object({
  warehouseId: z.string().uuid(),
  charterId: z.string().uuid().nullable().optional(),
  books: z.array(bookSchema).min(1).max(200),
});

export type BulkBookInput = z.infer<typeof inputSchema>;

interface BulkResult {
  created: number;
  skipped: number;
  errors: Array<{ isbn: string; reason: string }>;
}

/**
 * Creates inventory_items (item_type='book') from a list of resolved
 * book metadata in one batch. Each book uses its ISBN as both the SKU
 * (after de-dup) and barcode. ISBNs that collide with existing items in
 * the org are reported as skipped, not errors.
 */
export async function bulkCreateBooksAction(
  input: BulkBookInput,
): Promise<ActionResult<BulkResult>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid bulk import payload',
    );
  }
  try {
    const svc = await InventoryService.forCurrentUser();

    const result: BulkResult = { created: 0, skipped: 0, errors: [] };
    for (const b of parsed.data.books) {
      try {
        const sku = generateSku(b.title);
        const customFields: Record<string, unknown> = {};
        if (b.author && b.author.trim().length > 0) customFields.author = b.author.trim();
        if (b.description && b.description.trim().length > 0)
          customFields.description = b.description.trim();
        if (b.publisher) customFields.publisher = b.publisher;
        if (b.publishedDate) customFields.published_date = b.publishedDate;
        if (b.pageCount) customFields.page_count = b.pageCount;
        if (b.thumbnailUrl) customFields.thumbnail_url = b.thumbnailUrl;
        if (b.grade) customFields.book_grade = b.grade;

        await svc.create({
          name: b.title,
          sku,
          barcode: b.isbn,
          itemType: 'book',
          quantityOnHand: b.quantityOnHand,
          unitCost: b.unitCost,
          retailPrice: b.retailPrice,
          warehouseId: parsed.data.warehouseId,
          charterId: parsed.data.charterId ?? null,
          unitOfMeasure: 'unit',
          customFields,
          status: 'active',
          reorderPoint: 0,
          reorderQuantity: 0,
          trackingType: 'none',
        });
        result.created += 1;
      } catch (e) {
        if (e instanceof ServiceError) {
          if (e.code === 'conflict') {
            result.skipped += 1;
            continue;
          }
          result.errors.push({ isbn: b.isbn, reason: e.message });
        } else {
          result.errors.push({
            isbn: b.isbn,
            reason: e instanceof Error ? e.message : 'Unknown error',
          });
        }
      }
    }

    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
