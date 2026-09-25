/**
 * post_cycle_count raise codes -> user-facing copy (mobile twin of the web
 * service's mapPostCycleCountError in
 * apps/web/src/server/services/cycle-counts.ts).
 *
 * The phone posts through POST /api/v1/cycle-counts/[id]/post (SP-055), which
 * runs the web service, so the message that arrives is normally the web's
 * sentence already and passes through unchanged. This table is the FALLBACK
 * for a raw code that still arrives. Codes are stable across migrations (0079
 * v2, 0339 v4, 0342/0343, 0369); the strings are kept identical to the web
 * ones so a person sees the same sentence on both surfaces.
 */

export const POST_CYCLE_COUNT_ERROR_COPY: readonly (readonly [code: string, copy: string])[] = [
  // 0369, FIRST: the raise carries the item's SKU after the code, and a SKU is
  // free text (one containing "forbidden" must not match that code below).
  // Another count posted a correction for the item after this line was
  // counted; posting it would apply that correction twice.
  [
    'cycle_count_line_superseded',
    'Another count posted a correction for an item after this count recorded it, so posting would apply that correction twice. Clear and recount that line, then post again.',
  ],
  ['cycle_count_not_found', 'Cycle count not found.'],
  [
    'cycle_count_not_open',
    'This cycle count is no longer open. Reload to see the latest status.',
  ],
  ['forbidden', 'You do not have permission to post this cycle count.'],
  [
    'item_out_of_scope',
    'An item moved to a different warehouse mid-count. Cancel this count and restart it for the new warehouse, or clear the affected lines.',
  ],
  // 0339: a line counted before the migration whose stock moved cannot be
  // attributed (pre-count or post-count?) — refuse, recount.
  [
    'cycle_count_stale_line',
    'A line was counted before its stock changed and cannot be posted safely. Clear and recount that line, then post again.',
  ],
  // 0339: live + variance would go below zero — stock left after the count.
  [
    'cycle_count_negative_result',
    'Posting would take an item below zero because stock moved out after it was counted. Recount that line, then post again.',
  ],
];

/** Maps a post_cycle_count error message to copy; unknown messages pass through. */
export function postCycleCountErrorMessage(message: string | null | undefined): string {
  const raw = (message ?? '').trim();
  if (!raw) return 'Could not post the cycle count. Try again.';
  for (const [code, copy] of POST_CYCLE_COUNT_ERROR_COPY) {
    if (raw.includes(code)) return copy;
  }
  return raw;
}
