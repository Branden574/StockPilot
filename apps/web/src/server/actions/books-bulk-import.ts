'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
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
 * Creates inventory_items (item_type='book') from a list of resolved book
 * metadata in one batched server call. Delegates to InventoryService.bulkCreate
 * which hoists every per-row check (warehouse access, plan limit, charter
 * pairing) and does ONE INSERT for inventory_items + ONE for stock_movements.
 *
 * Compared to the previous per-row loop this drops ~500 sequential round
 * trips to ~7 total for a 100-book import — well within Vercel's 60s
 * function ceiling.
 *
 * ISBN collisions with existing items are detected via the service's
 * pre-flight barcode lookup and counted as `skipped`, matching the prior
 * per-row "conflict = skip" semantic.
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

    // Translate BulkBookInput → bulkCreate input shape. Custom fields hold
    // everything book-specific (author / description / publisher / grade /
    // thumbnail) so the inventory schema stays clean.
    const items = parsed.data.books.map((b) => {
      const customFields: Record<string, unknown> = {};
      if (b.author && b.author.trim().length > 0) customFields.author = b.author.trim();
      if (b.description && b.description.trim().length > 0)
        customFields.description = b.description.trim();
      if (b.publisher) customFields.publisher = b.publisher;
      if (b.publishedDate) customFields.published_date = b.publishedDate;
      if (b.pageCount) customFields.page_count = b.pageCount;
      if (b.thumbnailUrl) customFields.thumbnail_url = b.thumbnailUrl;
      if (b.grade) customFields.book_grade = b.grade;

      return {
        name: b.title,
        barcode: b.isbn,
        itemType: 'book' as const,
        quantityOnHand: b.quantityOnHand,
        unitCost: b.unitCost,
        retailPrice: b.retailPrice,
        unitOfMeasure: 'unit',
        trackingType: 'none' as const,
        customFields,
        status: 'active' as const,
        reorderPoint: 0,
        reorderQuantity: 0,
      };
    });

    const result = await svc.bulkCreate({
      warehouseId: parsed.data.warehouseId,
      charterId: parsed.data.charterId ?? null,
      items,
    });

    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard');

    return ok({
      created: result.created,
      skipped: result.skipped,
      // Service returns errors keyed by barcode; map back to isbn for the
      // existing client-side error UI.
      errors: result.errors.map((e) => ({ isbn: e.barcode, reason: e.reason })),
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
