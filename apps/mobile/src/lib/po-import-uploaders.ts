/**
 * Who uploaded each PO import, for the imports list and the review screen:
 * parity with the web's "Uploaded by" (PoImportsService.uploaderProfiles), and
 * the screens label the answer with the same core poImportUploaderLabel.
 *
 * Profiles are read with the screen's client under RLS, batched through
 * readProfilesByIds (the list carries up to 100 imports, and one `.in()` past
 * ~215 ids fails). A name is cosmetic, so a failed read never fails the
 * screen: it is warned about and answers null, which labels as "—", never as
 * "Former member" for everyone.
 *
 * Pure: the screens pass `supabase` in. Do not import ./supabase here.
 */

import type { PoImportUploaderProfile } from '@stockpilot/core';

import { settleIdBatchRead, type IdReadClient } from './id-batches';
import { readProfilesByIds } from './id-reads';

type UploaderProfileRow = PoImportUploaderProfile & { id: string };

/** The uploaders' profiles keyed by user id, or null when the read failed. */
export async function readPoImportUploaders(
  client: IdReadClient,
  uploaderIds: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, PoImportUploaderProfile> | null> {
  const read = await settleIdBatchRead(
    readProfilesByIds<UploaderProfileRow>(client, uploaderIds, 'id, full_name, email'),
  );
  if (read.ok) return read.value;
  console.warn('[po-imports] uploader names did not load', read.message);
  return null;
}
