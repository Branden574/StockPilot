import 'server-only';

import {
  indexDisplayGroupMemberships,
  type DisplayGroupMembershipRow,
  type DisplayGroupRef,
} from '@stockpilot/core';

import type { ServiceContext } from '../context';

import { fetchAllRowsByIds } from './fetch-by-ids';
import { fetchAllRows } from './paginate';

/**
 * The explicit display groups (Group selected, migration 0400) of the records
 * a list shows. Membership lives in its own table, never on inventory_items,
 * so a list reads it next to its rows and attaches it (core's display rule
 * decides the headers):
 *
 *   readDisplayGroupsByItemIds  the records on a page or in search hits, by
 *                               id (100 per `.in()`), through the CALLER'S
 *                               client: RLS returns a membership only when its
 *                               record is readable, and a group's name only
 *                               through a readable live record. Staff and
 *                               viewers, the phone's item screen, the search
 *                               route. A failed read is decoration lost, never
 *                               a failed list: the rows render ungrouped.
 *   readDisplayGroupsForOrg     every membership of an organization, for the
 *                               manager's cached loaders (admin client; those
 *                               loaders serve only callers who read every
 *                               record: canUseSharedInventoryCaches). Throws,
 *                               so a failed read is never cached.
 *
 * Both embed the group through the one key between the tables
 * (item_display_group_members_group_fk), named so the embed can never become
 * ambiguous (PGRST201).
 */

const MEMBERSHIP_SELECT =
  'item_id, group_id, item_display_groups!item_display_group_members_group_fk(id, name, version)';

/** The caller's client, or the admin client (both untyped: core's Database
 *  is `any`). */
type ReadClient = Pick<ServiceContext['supabase'], 'from'>;

interface PageResult {
  data: DisplayGroupMembershipRow[] | null;
  error: { message: string } | null;
}

/** Display group fields as the list rows carry them. */
export interface DisplayGroupFields {
  display_group_id: string | null;
  display_group_name: string | null;
  display_group_version: number | null;
}

/** The fields for a record, or nulls. */
export function displayGroupFields(ref: DisplayGroupRef | undefined): DisplayGroupFields {
  return {
    display_group_id: ref?.id ?? null,
    display_group_name: ref?.name ?? null,
    display_group_version: ref?.version ?? null,
  };
}

/** Rows with their display group attached (nulls when none or unknown). */
export function withDisplayGroups<T extends { id: string }>(
  rows: readonly T[],
  groups: ReadonlyMap<string, DisplayGroupRef>,
): Array<T & DisplayGroupFields> {
  return rows.map((r) => ({ ...r, ...displayGroupFields(groups.get(r.id)) }));
}

/**
 * Memberships of these records the caller may read (RLS), batched 100 ids per
 * request. Never throws: on a failed read it reports and answers what it has
 * (the list renders those records ungrouped, which is honest: no header claims
 * records it could not confirm).
 */
export async function readDisplayGroupsByItemIds(
  clientOrPromise: ReadClient | PromiseLike<ReadClient>,
  organizationId: string,
  itemIds: readonly string[],
): Promise<Map<string, DisplayGroupRef>> {
  const ids = [...new Set(itemIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();
  try {
    // A client still being made (a page's cookie client) is awaited inside
    // the try, so even a failure to make it renders the rows ungrouped.
    const client = await clientOrPromise;
    const rows = await fetchAllRowsByIds<DisplayGroupMembershipRow>(
      ids,
      (batch) => (from, to) =>
        client
          .from('item_display_group_members')
          .select(MEMBERSHIP_SELECT)
          .eq('organization_id', organizationId)
          .in('item_id', batch)
          .order('item_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult>,
    );
    return indexDisplayGroupMemberships(rows);
  } catch (err) {
    console.warn(
      '[display-groups] membership read failed; rows render ungrouped:',
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

/**
 * Every membership of an organization, with its open group's name and
 * version (admin client, the manager's cached loaders only). Two plain reads in
 * parallel (no embed), joined here: a membership whose group row is not open
 * keeps its id with no name. Throws on a failed read so nothing degraded is
 * cached.
 */
export async function readDisplayGroupsForOrg(
  admin: ReadClient,
  organizationId: string,
): Promise<Map<string, DisplayGroupRef>> {
  const [members, groups] = await Promise.all([
    fetchAllRows<{ item_id: string; group_id: string }>(
      (from, to) =>
        admin
          .from('item_display_group_members')
          .select('item_id, group_id')
          .eq('organization_id', organizationId)
          .order('item_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: Array<{ item_id: string; group_id: string }> | null;
          error: { message: string } | null;
        }>,
    ),
    fetchAllRows<{ id: string; name: string; version: number }>(
      (from, to) =>
        admin
          .from('item_display_groups')
          .select('id, name, version')
          .eq('organization_id', organizationId)
          .is('closed_at', null)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: Array<{ id: string; name: string; version: number }> | null;
          error: { message: string } | null;
        }>,
    ),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  return indexDisplayGroupMemberships(
    members.map((m) => ({ ...m, item_display_groups: byId.get(m.group_id) ?? null })),
  );
}
