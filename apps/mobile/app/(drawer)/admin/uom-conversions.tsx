import { ArrowLeftRight } from 'lucide-react-native';
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

interface ConversionRow {
  id: string;
  from_uom: string;
  to_uom: string;
  numerator: number;
  denominator: number;
  rounding_rule: string;
  item: { name: string | null; sku: string | null } | null;
}

export default function UoMConversionsAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<ConversionRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('uom_conversions')
      .select(
        `id, from_uom, to_uom, numerator, denominator, rounding_rule,
         item:inventory_items!item_id (name, sku)`,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(200);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const i = r.item as { name: string | null; sku: string | null } | { name: string | null; sku: string | null }[] | null;
        return {
          id: r.id as string,
          from_uom: r.from_uom as string,
          to_uom: r.to_uom as string,
          numerator: Number(r.numerator) || 1,
          denominator: Number(r.denominator) || 1,
          rounding_rule: r.rounding_rule as string,
          item: Array.isArray(i) ? i[0] ?? null : i,
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
        eyebrow="ADMIN · UOM"
        title="Restricted"
        italic="access."
        emptyIcon={ArrowLeftRight}
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
      eyebrow={`ADMIN · ${rows.length} CONVERSIONS`}
      title="UoM"
      italic="conversions."
      emptyTitle="No conversions yet."
      emptyBody="Define per-item PK → EA, CT → EA, dozens → EA conversions on the web so receiving knows how to fan out vendor packs."
      emptyIcon={ArrowLeftRight}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <ConversionCard conv={c} />}
    />
  );
}

function ConversionCard({ conv }: { conv: ConversionRow }) {
  const { c } = useTheme();
  const ratio =
    conv.denominator === 1
      ? `1 ${conv.from_uom} = ${conv.numerator} ${conv.to_uom}`
      : `${conv.denominator} ${conv.from_uom} = ${conv.numerator} ${conv.to_uom}`;
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
            — {conv.item?.sku ?? 'unknown'}
          </Mono>
          <Body size={14} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }} numberOfLines={2}>
            {conv.item?.name ?? 'Unknown item'}
          </Body>
          <Mono size={13} tracking={0.02} color={c.ink2} style={{ marginTop: 6 }}>
            {ratio}
          </Mono>
        </View>
        <Pill>{conv.rounding_rule.toUpperCase()}</Pill>
      </View>
    </Card>
  );
}
