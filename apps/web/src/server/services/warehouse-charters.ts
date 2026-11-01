import 'server-only';

import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { LOOKUP_ROW_CEILING, reportLookupCeiling } from './lib/lookup-ceiling';
import { fetchAllRows } from './lib/paginate';
import { postgrestErrorText } from './lib/postgrest-error';

export interface WarehouseCharterPair {
  warehouse_id: string;
  charter_id: string;
}

/** The ceiling as people read it: "10,000". */
function ceilingText(): string {
  return LOOKUP_ROW_CEILING.toLocaleString('en-US');
}

export class WarehouseChartersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new WarehouseChartersService(await withContext());
  }

  /**
   * Lists every (warehouse, charter) pairing in the current org. Used by the
   * item form to filter charter options once a warehouse is picked. Pairs are
   * already constrained by RLS to the user's visible orgs.
   *
   * Every row, page by page (fetchAllRows), ordered by warehouse and then
   * charter: the table has no id column, and (warehouse_id, charter_id) is its
   * key. It was one read with no order, so past 1000 links (four warehouses
   * that each serve 251 charters; archived charters keep their links) PostgREST
   * answered an arbitrary 1000 with no error, and the item forms, Team's member
   * Charters dialog and the warehouse page could not offer the rest (B47).
   *
   * It stops at LOOKUP_ROW_CEILING links (the first by warehouse, then
   * charter), reported once. The pages that save from this list do not act on
   * a list cut there: Team's member Charters save refuses
   * (TeamService.setMemberCharterAssignments), and the item and Books edit
   * forms leave the charter to the server's own check.
   */
  async listPairs(): Promise<WarehouseCharterPair[]> {
    const pairs = await fetchAllRows<WarehouseCharterPair>(
      (from, to) =>
        this.ctx.supabase
          .from('warehouse_charters')
          .select('warehouse_id, charter_id')
          .eq('organization_id', this.ctx.organizationId)
          .order('warehouse_id', { ascending: true })
          .order('charter_id', { ascending: true })
          .range(from, to),
      { cap: LOOKUP_ROW_CEILING },
    );
    if (pairs.length >= LOOKUP_ROW_CEILING) {
      reportLookupCeiling('warehouse_charters.list_pairs', {
        organizationId: this.ctx.organizationId,
      });
    }
    return pairs;
  }

  /**
   * Replaces the full charter list a warehouse services. Sends an audit event
   * with the diff (added / removed). Admin-only.
   *
   * Checks everything first and writes after (prepareSetForWarehouse), so a
   * refusal writes nothing.
   */
  async setForWarehouse(warehouseId: string, charterIds: string[]) {
    const apply = await this.prepareSetForWarehouse(warehouseId, charterIds);
    await apply();
  }

  /**
   * Every read and every refusal of a charter save, before any write. Returns
   * the writes, to run once the caller has nothing left to refuse:
   * WarehousesService.update calls this BEFORE it writes the warehouse row, so
   * a refused save leaves the row, the links and the staff charter
   * assignments as they were (B47 decisions round).
   *
   * Refuses, in plain words:
   * - when this warehouse's current links reach LOOKUP_ROW_CEILING: the
   *   comparison would run on part of them;
   * - when the save would remove a link and the organization has
   *   LOOKUP_ROW_CEILING links or more: the editor's list
   *   (WarehousesService.list) stops at the ceiling too, so a link it could
   *   not show would be removed though nobody unticked it;
   * - when items, deleted ones included, are still tagged to a removed
   *   charter here (inventory_items_warehouse_charter_fk is ON DELETE
   *   RESTRICT and sees deleted rows too);
   * - when either count cannot be read.
   */
  async prepareSetForWarehouse(
    warehouseId: string,
    charterIds: string[],
  ): Promise<() => Promise<void>> {
    assertPermission(this.ctx, 'organization:update');

    // Every current link, page by page, ordered by charter (B47 part C). One
    // read with no range stopped at 1000 links on the warehouse, so a save
    // that changed nothing re-inserted links that already existed and failed
    // on the primary key; and its error was ignored, so a failed read was "no
    // links". A failed page now throws before any insert, count or delete.
    // The editor's list comes from WarehousesService.list, which reads every
    // link too, so both sides of this comparison are complete.
    const current = await fetchAllRows<{ charter_id: string }>(
      (from, to) =>
        this.ctx.supabase
          .from('warehouse_charters')
          .select('charter_id')
          .eq('organization_id', this.ctx.organizationId)
          .eq('warehouse_id', warehouseId)
          .order('charter_id', { ascending: true })
          .range(from, to),
      { cap: LOOKUP_ROW_CEILING },
    );
    if (current.length >= LOOKUP_ROW_CEILING) {
      reportLookupCeiling('warehouse_charters.set_for_warehouse', { warehouseId });
      throw new ServiceError(
        'conflict',
        `This warehouse is linked to ${ceilingText()} or more charters, more than this page can check, so nothing was saved.`,
      );
    }

    const existing = new Set(current.map((r) => r.charter_id));
    const desired = new Set(charterIds);

    const toAdd = [...desired].filter((id) => !existing.has(id));
    const toRemove = [...existing].filter((id) => !desired.has(id));

    if (toRemove.length > 0) {
      await this.assertEditorListComplete(warehouseId);
      await this.assertNoItemsOnRemovedCharters(warehouseId, toRemove);
    }

    return async () => {
      if (toAdd.length > 0) {
        const { error: insErr } = await this.ctx.supabase.from('warehouse_charters').insert(
          toAdd.map((charter_id) => ({
            organization_id: this.ctx.organizationId,
            warehouse_id: warehouseId,
            charter_id,
          })),
        );
        if (insErr) throw new ServiceError('internal_error', insErr.message);
      }

      if (toRemove.length > 0) {
        const { error: delErr } = await this.ctx.supabase
          .from('warehouse_charters')
          .delete()
          .eq('organization_id', this.ctx.organizationId)
          .eq('warehouse_id', warehouseId)
          // in-list-bound: charters removed from one warehouse (the org's charters, a few dozen at most)
          .in('charter_id', toRemove);
        if (delErr) throw new ServiceError('internal_error', delErr.message);
      }

      await audit(
        {
          event: 'warehouse_charters.updated',
          entityType: 'warehouse',
          entityId: warehouseId,
          before: { charterIds: [...existing] },
          after: { charterIds: [...desired] },
        },
        this.ctx,
      );
    };
  }

  /**
   * The Admin > Warehouses editor starts from WarehousesService.list, whose
   * links read stops at LOOKUP_ROW_CEILING for the whole organization. At
   * that many links a warehouse's list in the editor may be cut, and every
   * link it could not show would be in this save's removals. So a save that
   * removes a link refuses then. A failed count refuses too: it cannot tell.
   */
  private async assertEditorListComplete(warehouseId: string): Promise<void> {
    const res = await this.ctx.supabase
      .from('warehouse_charters')
      .select('charter_id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId);
    if (res.error || typeof res.count !== 'number') {
      void reportError(
        new Error(
          `warehouse charter links count failed: ${res.error ? postgrestErrorText(res.error, res) : 'no count in the answer'}`,
        ),
        { tag: 'warehouse_charters.save_check', extra: { warehouseId, check: 'links' } },
      );
      throw new ServiceError(
        'conflict',
        "Could not check this organization's warehouse charter links, so nothing was saved. Try again.",
      );
    }
    if (res.count >= LOOKUP_ROW_CEILING) {
      throw new ServiceError(
        'conflict',
        `This organization has ${ceilingText()} or more warehouse charter links, more than this page can list, so a charter cannot be removed from a warehouse here. Nothing was saved.`,
      );
    }
  }

  /**
   * The friendly form of inventory_items_warehouse_charter_fk (ON DELETE
   * RESTRICT): removing a link that items use is refused. It counts what the
   * key sees, deleted items included (archiving an item only sets
   * deleted_at, and the key still holds it), so "archive them" never cleared
   * it. A failed count refuses instead of counting as none (B47 decisions
   * round, lead L-7): it used to run the delete into the key, and the toast
   * said "An internal error occurred".
   */
  private async assertNoItemsOnRemovedCharters(
    warehouseId: string,
    toRemove: string[],
  ): Promise<void> {
    const res = await this.ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('warehouse_id', warehouseId)
      // in-list-bound: charters removed from one warehouse (the org's charters, a few dozen at most)
      .in('charter_id', toRemove);
    if (res.error || typeof res.count !== 'number') {
      void reportError(
        new Error(
          `items on removed charters count failed: ${res.error ? postgrestErrorText(res.error, res) : 'no count in the answer'}`,
        ),
        { tag: 'warehouse_charters.save_check', extra: { warehouseId, check: 'items' } },
      );
      throw new ServiceError(
        'conflict',
        'Could not check which items use the charters you removed, so nothing was saved. Try again.',
      );
    }
    const count = res.count;
    if (count > 0) {
      throw new ServiceError(
        'conflict',
        `Cannot remove a charter: ${count} ${count === 1 ? 'item' : 'items'} at this warehouse, deleted ones included, ${count === 1 ? 'is' : 'are'} still tagged to it. Move ${count === 1 ? 'it' : 'them'} to another charter or warehouse, or restore deleted ones from Settings > Recovery and retag them. Nothing was saved.`,
      );
    }
  }
}
