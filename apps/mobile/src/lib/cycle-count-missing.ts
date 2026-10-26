/**
 * WHEN THE COUNT SCREEN'S READ FINDS NO COUNT (B25, the F1-3 follow-up).
 *
 * app/cycle-count/[id].tsx reads the count as `cycle_counts` where the id is
 * the link's AND the organization is the workspace on screen. With no copy on
 * the phone, a read that answered no row and no error rendered the ordinary
 * count screen with nothing in it, and so said "This count has no lines yet.
 * Add lines from the web first." about a count that was not there: a link to a
 * count in another of the person's workspaces (a notification, a shared link,
 * a scan), a count id that does not exist, or a count in an organization the
 * person is not a member of (row-level security answers that as no row).
 *
 * "No lines yet" is now said only of a count that was read and has none. A
 * missing one is told apart with one more read, without the workspace filter:
 * row-level security returns the count only to a member of its organization,
 * so a row there is a count in another of the person's workspaces. Anything
 * else (no row, a refused or failed read) is said the way the exception
 * screen says it for a 404: not available to this person, or gone.
 */

export type MissingCount = 'other-workspace' | 'not-available';

/** The Supabase surface this needs (the client in the app; a fake in tests). */
export interface MissingCountClient {
  from(table: 'cycle_counts'): unknown;
}

interface MissingCountChain {
  select(columns: string): MissingCountChain;
  eq(column: string, value: string): MissingCountChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Why the read of `countId` in the workspace `orgId` found no row. Never
 * throws: a read that fails says "not available".
 */
export async function whyCountIsMissing(
  client: MissingCountClient,
  countId: string,
  orgId: string,
): Promise<MissingCount> {
  try {
    const res = await (client.from('cycle_counts') as MissingCountChain)
      .select('organization_id')
      .eq('id', countId)
      .maybeSingle();
    if (!res || res.error || !res.data) return 'not-available';
    const owner = (res.data as { organization_id?: unknown }).organization_id;
    return typeof owner === 'string' && owner !== orgId ? 'other-workspace' : 'not-available';
  } catch {
    return 'not-available';
  }
}

export const COUNT_NOT_AVAILABLE_TITLE = 'Count not available';
export const COUNT_NOT_AVAILABLE_COPY =
  'This count is not available to you, or it no longer exists.';
export const COUNT_IN_OTHER_WORKSPACE_TITLE = 'Count in another workspace';
export const COUNT_IN_OTHER_WORKSPACE_COPY =
  'This count belongs to another of your workspaces. Switch workspace from the menu to open it.';

/** The empty state's title and words for a missing count. */
export function missingCountCopy(why: MissingCount): { title: string; body: string } {
  return why === 'other-workspace'
    ? { title: COUNT_IN_OTHER_WORKSPACE_TITLE, body: COUNT_IN_OTHER_WORKSPACE_COPY }
    : { title: COUNT_NOT_AVAILABLE_TITLE, body: COUNT_NOT_AVAILABLE_COPY };
}
