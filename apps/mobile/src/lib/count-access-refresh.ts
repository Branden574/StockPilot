import type { ScreenAccess } from './screen-access';

/**
 * WHEN A COUNT ON SCREEN IS READ AGAIN IN PLACE (S75).
 *
 * While the workspace is not synced yet for this member, the count screen and
 * the barcode scanner show a count this account fetched (screen-access.ts
 * 'not-synced'). When the pull lands, the access turns to 'allowed' and both
 * read the count again. That read must not take the screen from a counter who
 * is typing or scanning.
 */

/** What a count screen's load ran for: the count, the workspace, the account and the access. */
export interface CountLoadKey {
  id: string | undefined;
  orgId: string | null;
  userId: string | null;
  access: ScreenAccess;
}

/**
 * Whether the count screen reads again without its spinner and without
 * resetting what is on screen: the same count in the same workspace for the
 * same account, lines on screen, and the access turned from 'not-synced' to
 * 'allowed'. Any other change (a first load, another count, workspace or
 * account, an access refused) is the full load, with its spinner.
 */
export function countReloadIsQuiet(
  before: CountLoadKey | null,
  now: CountLoadKey,
  linesShown: boolean,
): boolean {
  return (
    before !== null &&
    linesShown &&
    before.id === now.id &&
    before.orgId === now.orgId &&
    before.userId === now.userId &&
    before.access === 'not-synced' &&
    now.access === 'allowed'
  );
}

/**
 * Whether a full load starts from an empty screen: it is for another count,
 * workspace or account than the one on screen, so what is drawn (the count
 * screen's header and lines, the scanner's lines and tally) is cleared before
 * the read, and a read that finds nothing never leaves the previous one
 * drawn. The first load has nothing to clear; an access change for the same
 * count keeps it (the quiet read, or a refusal drawn over it).
 */
export function countLoadClearsScreen(before: CountLoadKey | null, now: CountLoadKey): boolean {
  return (
    before !== null &&
    (before.id !== now.id || before.orgId !== now.orgId || before.userId !== now.userId)
  );
}

/**
 * The scanner's tally after it reads the lines again: what this screen
 * scanned stays, a counted line the phone holds is added, and a line no
 * longer in the count goes. With nothing scanned yet, the phone's copy (as
 * the first read always was).
 */
export function mergeScannedCounts(
  scanned: ReadonlyMap<string, number>,
  lines: readonly { id: string; counted: number | null }[],
): Map<string, number> {
  const merged = new Map<string, number>();
  for (const line of lines) {
    const mine = scanned.get(line.id);
    if (mine !== undefined) merged.set(line.id, mine);
    else if (line.counted != null) merged.set(line.id, line.counted);
  }
  return merged;
}
