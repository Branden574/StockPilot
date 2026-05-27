import { MapPin } from 'lucide-react-native';
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

interface BinRow {
  id: string;
  code: string;
  name: string;
  bin_type: string;
  is_default: boolean;
  status: string;
  warehouse: { name: string | null; code: string | null } | null;
}

export default function BinsAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<BinRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('bins')
      .select(
        `id, code, name, bin_type, is_default, status,
         warehouse:warehouses!warehouse_id (name, code)`,
      )
      .eq('organization_id', orgId)
      .order('code', { ascending: true })
      .limit(200);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const wh = r.warehouse as { name: string | null; code: string | null } | { name: string | null; code: string | null }[] | null;
        return {
          id: r.id as string,
          code: r.code as string,
          name: r.name as string,
          bin_type: r.bin_type as string,
          is_default: Boolean(r.is_default),
          status: r.status as string,
          warehouse: Array.isArray(wh) ? wh[0] ?? null : wh,
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
        eyebrow="ADMIN · BINS"
        title="Restricted"
        italic="access."
        emptyIcon={MapPin}
        emptyTitle="Admin only."
        emptyBody=""
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow={`ADMIN · ${rows.length} BINS`}
      title="Bins"
      italic="& putaway."
      emptyTitle="No bins yet."
      emptyBody="Bins live inside warehouses for pick paths and damage holds."
      emptyIcon={MapPin}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(b) => b.id}
      renderItem={(b) => <BinCard bin={b} />}
    />
  );
}

function BinCard({ bin }: { bin: BinRow }) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
            — {bin.warehouse?.code ?? '—'} · {bin.bin_type}
          </Mono>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
            <Mono size={16} tracking={0.01} color={c.ink}>
              {bin.code}
            </Mono>
            <Body size={13} color={c.ink3} style={{ fontFamily: FONT.displayRegular }}>
              {bin.name}
            </Body>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Pill status={bin.status === 'active' ? 'ok' : 'warn'}>{bin.status.toUpperCase()}</Pill>
          {bin.is_default ? <Pill>DEFAULT</Pill> : null}
        </View>
      </View>
    </Card>
  );
}
