import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isSiteLocation } from '@stockpilot/core';

import {
  unofferedDestinationFrom,
  type UnofferedDestination,
  type UnofferedSupplier,
} from '@/lib/purchase-orders/unoffered-choice';

import { fetchAllRowsByIds, reportDegradedRead } from './fetch-by-ids';

/**
 * The server reads behind "a value the form does not offer" (small fixes
 * slice 8; lib/purchase-orders/unoffered-choice.ts): what a purchase order or
 * recurring template holds that its Destination or Supplier select does not
 * list, read by id in the caller's organization, through the caller's client
 * (row-level security decides what it may read; deleted locations and archived
 * suppliers stay readable to members).
 *
 * Labels, never a decision: a failed read is reported and every id comes back
 * unnamed ('unknown'), so the form still keeps none of them and says so
 * without a name. Never an error page (recurring pattern #1).
 */

interface LocationRow {
  id: string;
  name: string | null;
  kind: string | null;
  type: string | null;
  warehouse_id: string | null;
  deleted_at: string | null;
}

/**
 * Each of `ids` as a destination the forms cannot offer: deleted, not a site
 * (a staging area, a rack), a site with no warehouse, or unknown (not found,
 * or the read failed). `tag` names the caller in the report of a failed read.
 */
export async function readUnofferedDestinations(
  client: SupabaseClient,
  organizationId: string,
  ids: readonly string[],
  tag: string,
): Promise<Map<string, UnofferedDestination>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, UnofferedDestination>();
  if (wanted.length === 0) return out;
  let rows: LocationRow[] = [];
  try {
    rows = await fetchAllRowsByIds<LocationRow>(wanted, (batch) => (from, to) =>
      client
        .from('locations')
        .select('id, name, kind, type, warehouse_id, deleted_at')
        .eq('organization_id', organizationId)
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to),
    );
  } catch (err) {
    reportDegradedRead(tag, err, { ids: wanted.length });
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of wanted) {
    const row = byId.get(id);
    out.set(id, row ? unofferedDestinationFrom(row, isSiteLocation(row)) : { name: null, why: 'unknown' });
  }
  return out;
}

/**
 * What the forms should do with suppliers their Supplier select does not
 * list (`ids`): an ARCHIVED one is named and not kept (`unoffered`); one
 * still active, which the select lacks only because the Suppliers module is
 * off (SuppliersService.listForLookups then lists none), is offered after all
 * (`fold`), so the form shows it and can keep it; one not found, or every one
 * when the read failed, is unnamed (`unoffered`, 'unknown').
 *
 * `namesByIds` is SuppliersService.namesByIds: archived suppliers included,
 * not gated on the module, batched; it throws on a failed read.
 */
export async function readUnofferedSuppliers(
  namesByIds: (ids: readonly string[]) => Promise<Array<{ id: string; name: string; deleted_at: string | null }>>,
  ids: readonly string[],
  tag: string,
): Promise<{ unoffered: Map<string, UnofferedSupplier>; fold: Array<{ id: string; name: string }> }> {
  const wanted = [...new Set(ids.filter(Boolean))];
  const unoffered = new Map<string, UnofferedSupplier>();
  const fold: Array<{ id: string; name: string }> = [];
  if (wanted.length === 0) return { unoffered, fold };
  let rows: Array<{ id: string; name: string; deleted_at: string | null }> = [];
  try {
    rows = await namesByIds(wanted);
  } catch (err) {
    reportDegradedRead(tag, err, { ids: wanted.length });
  }
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  for (const id of wanted) {
    const row = byId.get(id.toLowerCase());
    const name = (row?.name ?? '').trim() || null;
    if (!row) unoffered.set(id, { name: null, why: 'unknown' });
    else if (row.deleted_at) unoffered.set(id, { name, why: 'archived' });
    else fold.push({ id, name: name ?? 'Unnamed supplier' });
  }
  return { unoffered, fold };
}
