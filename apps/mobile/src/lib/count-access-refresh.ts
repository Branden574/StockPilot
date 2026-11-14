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
 * Whether an answer that started under `started` may still be drawn, or a
 * review built under it still sent, now that the screen's key is `now` (what
 * its last load ran for): the same count, workspace and account, with the
 * access the same or widened to 'allowed' (the phone finished syncing).
 * Another count, workspace or account, a sign-out, or an access narrowed
 * since, and the answer is dropped: the screen has cleared what it drew and
 * reads again for the key it has now. Two absent keys are the same.
 */
export function countAnswerStillShown(
  started: CountLoadKey | null,
  now: CountLoadKey | null,
): boolean {
  if (started === null || now === null) return started === now;
  return (
    started.id === now.id &&
    started.orgId === now.orgId &&
    started.userId === now.userId &&
    (started.access === now.access || now.access === 'allowed')
  );
}

/**
 * What a full load does with the counts typed on screen and not saved yet
 * (the count screen's drafts, the scanner's confirm sheet):
 *   - 'keep': the screen is not cleared (countLoadClearsScreen);
 *   - 'drop': cleared for another account (a sign-out included), or for
 *     another workspace than the one they were typed in: never saved under
 *     the account or workspace now on screen;
 *   - 'save': cleared for another count of the same account and workspace,
 *     or the workspace has just become known (or gone) for the same account:
 *     saved at once, as on leaving the screen (a save the phone refuses is
 *     said, as always).
 */
export type CountDraftAction = 'keep' | 'drop' | 'save';

export function countLoadDraftAction(
  before: CountLoadKey | null,
  now: CountLoadKey,
): CountDraftAction {
  if (before === null || !countLoadClearsScreen(before, now)) return 'keep';
  if (before.userId !== now.userId) return 'drop';
  if (before.orgId !== null && now.orgId !== null && before.orgId !== now.orgId) return 'drop';
  return 'save';
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
