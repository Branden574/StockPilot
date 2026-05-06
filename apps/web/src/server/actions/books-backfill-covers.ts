'use server';

import { revalidatePath } from 'next/cache';

import { BooksImportService } from '@/server/services/books-import';
import { ServiceError, withContext } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

interface BackfillResult {
  rehosted: number;
  alreadyHadPrimary: number;
  noUrlOnRow: number;
  failed: number;
  scanned: number;
}

/**
 * One-shot rehost of every book in the org that has a third-party
 * cover URL but no `item_images` row. Existing books imported before
 * the rehost flow landed need this to recover from broken
 * archive.org redirects in their custom_fields.thumbnail_url. Future
 * imports already rehost as part of execute() so this is idempotent
 * and safe to re-run any time.
 */
export async function backfillBookCoversAction(): Promise<ActionResult<BackfillResult>> {
  try {
    const ctx = await withContext();
    const svc = new BooksImportService(ctx);
    const result = await svc.backfillCovers({ limit: 500 });
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/inventory');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
