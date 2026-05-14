'use server';

import { z } from 'zod';

import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';
import { err, ok, type ActionResult } from '@stockpilot/core';

const schema = z.object({
  isbn: z
    .string()
    .min(8)
    .max(20)
    .regex(/^[0-9Xx-]+$/, 'Invalid ISBN'),
});

export async function lookupBookByIsbnAction(
  input: z.input<typeof schema>,
): Promise<ActionResult<{ matches: Array<{ id: string; name: string }> }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid ISBN');
  const isbn = parsed.data.isbn.replace(/[^0-9Xx]/g, '');
  try {
    const svc = await InventoryService.forCurrentUser();
    const result = await svc.list({
      barcode: isbn,
      itemType: 'book',
      status: 'active',
      limit: 5,
    });
    return ok({
      matches: result.items.map((i) => ({
        id: i.id as string,
        name: i.name as string,
      })),
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
