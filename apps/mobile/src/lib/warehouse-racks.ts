import { fetchAllPages } from './id-batches';
import { supabase } from './supabase';

/**
 * Every live rack name in ONE warehouse: the set the server's resolve-or-create
 * (LocationsService.findRackOrCrate) searches before it mints a new rack. Same
 * scope, same filters: org, warehouse, kind 'rack', not deleted.
 *
 * Returns null when the read fails, never []. An empty list means "this
 * warehouse has no racks", so every typed rack would read as new, and a
 * failure must not be remembered as that. The caller asks instead.
 */
export async function loadWarehouseRackNames(
  organizationId: string,
  warehouseId: string,
): Promise<string[] | null> {
  try {
    const rows = await fetchAllPages<{ id: string; name: string | null }>((from, to) =>
      supabase
        .from('locations')
        .select('id, name')
        .eq('organization_id', organizationId)
        .eq('warehouse_id', warehouseId)
        .eq('kind', 'rack')
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    return rows.map((r) => r.name ?? '').filter((n) => n.trim().length > 0);
  } catch {
    return null;
  }
}
