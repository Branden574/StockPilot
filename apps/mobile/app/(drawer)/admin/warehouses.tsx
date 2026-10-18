import { Warehouse } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  status: string;
  contact_name: string | null;
  charter: { name: string | null } | null;
}

/** No rows yet (one array, so an empty list keeps one identity). */
const NO_ROWS: WarehouseRow[] = [];

/**
 * Admin · Warehouses with their first charter, read only. A read that fails
 * is said as a failure, never "No warehouses yet." (D25): with no rows its
 * words stand in for the list, with rows from an earlier read they stay under
 * "Could not refresh", and the eyebrow quotes no count it did not read. When
 * the warehouses arrive but their charters do not, the list shows and says
 * the charters could not be loaded (a warehouse is never shown as having no
 * charter only because that read failed).
 */
export default function WarehousesAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  // The rows on screen and the workspace they were read for: a failed read
  // keeps them only when they are this workspace's (never the last
  // workspace's rows under "Could not refresh" after a switch).
  const [list, setList] = React.useState<{ orgId: string; rows: WarehouseRow[] } | null>(null);
  const rows = list?.rows ?? NO_ROWS;
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // The last read failed: 'list' (the warehouses), 'charters' (the list
  // arrived without its charter names), or null.
  const [failed, setFailed] = React.useState<'list' | 'charters' | null>(null);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const forOrg = orgId;
    // `warehouses.charter_id` was dropped in migration 0008 — charters
    // are now linked through the `warehouse_charters` join table.
    // Selecting the removed column previously errored and zeroed the
    // results. Now we fetch warehouses + the join in parallel and
    // resolve each warehouse to its first associated charter for the
    // single-pill display.
    let reads;
    try {
      reads = await Promise.all([
        supabase
          .from('warehouses')
          .select('id, name, code, status, contact_name')
          .eq('organization_id', orgId)
          .order('name', { ascending: true }),
        supabase
          .from('warehouse_charters')
          .select('warehouse_id, charter_id')
          .eq('organization_id', orgId),
      ]);
    } catch {
      setList((prev) => (prev !== null && prev.orgId === forOrg ? prev : null));
      setFailed('list');
      setLoading(false);
      return;
    }
    const [whResp, joinResp] = reads;
    if (whResp.error) {
      console.warn('[admin/warehouses] fetch failed:', whResp.error.message);
      setList((prev) => (prev !== null && prev.orgId === forOrg ? prev : null));
      setFailed('list');
      setLoading(false);
      return;
    }
    if (joinResp.error) {
      console.warn('[admin/warehouses] charter-join fetch failed:', joinResp.error.message);
    }
    let chartersFailed = Boolean(joinResp.error);
    const whRows = (whResp.data ?? []) as {
      id: string;
      name: string;
      code: string;
      status: string;
      contact_name: string | null;
    }[];
    const joinRows = (joinResp.data ?? []) as {
      warehouse_id: string;
      charter_id: string;
    }[];
    const warehouseToCharter = new Map<string, string>();
    for (const j of joinRows) {
      if (!warehouseToCharter.has(j.warehouse_id)) {
        warehouseToCharter.set(j.warehouse_id, j.charter_id);
      }
    }
    const charterIds = Array.from(new Set(joinRows.map((j) => j.charter_id)));
    let charterMap = new Map<string, string>();
    if (charterIds.length > 0) {
      const { data: charters, error: chErr } = await supabase
        .from('charters')
        .select('id, name')
        // in-list-bound: distinct charters linked to the org's warehouses, bounded by its charters (a dozen or so)
        .in('id', charterIds);
      if (chErr) {
        console.warn('[admin/warehouses] charter fetch failed:', chErr.message);
        chartersFailed = true;
      }
      charterMap = new Map(
        (charters ?? []).map((c) => [c.id as string, (c.name as string | null) ?? '']),
      );
    }
    setList({
      orgId: forOrg,
      rows: whRows.map((w) => {
        const chId = warehouseToCharter.get(w.id);
        return {
          id: w.id,
          name: w.name,
          code: w.code,
          status: w.status,
          contact_name: w.contact_name,
          charter: chId ? { name: charterMap.get(chId) ?? null } : null,
        };
      }),
    });
    // Missing charters matter only when there are warehouses to name them on.
    setFailed(chartersFailed && whRows.length > 0 ? 'charters' : null);
    setLoading(false);
  }, [orgId, isAdmin]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await except the pre-await guard that resolves loading for the unauthorized; the effect synchronizes with the server
    if (!roleLoading) void load();
  }, [load, roleLoading]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!roleLoading && !isAdmin) {
    return (
      <DataListScreen
        eyebrow="ADMIN · WAREHOUSES"
        title="Restricted"
        italic="access."
        emptyIcon={Warehouse}
        emptyTitle="Admin only."
        emptyBody="Warehouse setup is gated to admins and owners."
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow={
        failed === 'list' && rows.length === 0
          ? 'ADMIN · WAREHOUSES'
          : `ADMIN · ${rows.length} WAREHOUSES`
      }
      title="Warehouses"
      italic="."
      emptyTitle="No warehouses yet."
      emptyBody="A warehouse is a physical site that holds its own inventory. Create one on the web."
      emptyIcon={Warehouse}
      failed={
        failed
          ? {
              title: 'Could not load warehouses.',
              body: 'Check your connection and pull down to try again.',
              reloadNote:
                failed === 'charters'
                  ? 'Could not load the charters. Pull down to try again.'
                  : 'Could not refresh. Showing the last list.',
            }
          : null
      }
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(w) => w.id}
      renderItem={(w) => <WarehouseCard wh={w} />}
    />
  );
}

function WarehouseCard({ wh }: { wh: WarehouseRow }) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={9.5} tracking={0.18} upper color={c.ink3}>
            — {wh.code}
          </Mono>
          <Body size={15} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
            {wh.name}
          </Body>
          {wh.charter?.name ? (
            <Mono size={11} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}>
              {wh.charter.name}
              {wh.contact_name ? ` · ${wh.contact_name}` : ''}
            </Mono>
          ) : wh.contact_name ? (
            <Mono size={11} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}>
              {wh.contact_name}
            </Mono>
          ) : null}
        </View>
        <Pill status={wh.status === 'active' ? 'ok' : 'warn'}>{wh.status.toUpperCase()}</Pill>
      </View>
    </Card>
  );
}
