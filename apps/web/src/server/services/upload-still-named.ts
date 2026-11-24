import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * WHETHER A RECORD STILL NAMES AN UPLOAD'S OBJECTS (part 6): asked before a
 * refused upload's objects are removed, so a refusal never deletes a file a
 * row already points at (this upload recorded before, a duplicated row, a
 * cancelled earlier import, a second finalize of one upload). Read with the
 * service role, so a member's own read rules cannot hide a row, across every
 * column of the table that holds an object path. Throws on a failed look:
 * the caller keeps the objects (upload-checks.ts removeRefused).
 */
/** The tables whose rows name an upload's objects. */
export type UploadRecordTable =
  | 'item_images'
  | 'order_request_attachments'
  | 'organizations'
  | 'po_attachments'
  | 'procedure_videos'
  | 'support_tickets'
  | 'user_profiles';

export async function uploadObjectsStillNamed(
  table: UploadRecordTable,
  columns: readonly string[],
  paths: readonly string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  const admin = createAdminClient();
  for (const column of columns) {
    const { data, error } = await admin
      .from(table)
      .select('id')
      // in-list-bound: one upload's objects (a file and its thumbnail or poster), two paths at most
      .in(column, [...paths])
      .limit(1);
    if (error) throw new Error(`${table}.${column} look failed`);
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}
