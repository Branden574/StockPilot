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

export default function WarehousesAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<WarehouseRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('warehouses')
      .select(
        `id, name, code, status, contact_name,
         charter:charters!charter_id (name)`,
      )
      .eq('organization_id', orgId)
      .order('name', { ascending: true });
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const ch = r.charter as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          name: r.name as string,
          code: r.code as string,
          status: r.status as string,
          contact_name: (r.contact_name as string | null) ?? null,
          charter: Array.isArray(ch) ? ch[0] ?? null : ch,
        };
      }),
    );
    setLoading(false);
  }, [orgId, isAdmin]);

  React.useEffect(() => {
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
      eyebrow={`ADMIN · ${rows.length} WAREHOUSES`}
      title="Warehouses"
      italic="."
      emptyTitle="No warehouses yet."
      emptyBody="A warehouse is a physical site that holds its own inventory. Create one on the web."
      emptyIcon={Warehouse}
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
          <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
            — {wh.code}
          </Mono>
          <Body size={15} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
            {wh.name}
          </Body>
          {wh.charter?.name ? (
            <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {wh.charter.name}
              {wh.contact_name ? ` · ${wh.contact_name}` : ''}
            </Mono>
          ) : wh.contact_name ? (
            <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {wh.contact_name}
            </Mono>
          ) : null}
        </View>
        <Pill status={wh.status === 'active' ? 'ok' : 'warn'}>{wh.status.toUpperCase()}</Pill>
      </View>
    </Card>
  );
}
