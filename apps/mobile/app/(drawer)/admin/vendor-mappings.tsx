import { Layers } from 'lucide-react-native';
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

interface MappingRow {
  id: string;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  vendor_description: string | null;
  vendor_uom: string | null;
  pack_qty: number | null;
  conversion_factor: number | null;
  match_source: string;
  confidence_score: number | null;
  vendor: { name: string | null } | null;
  item: { name: string | null; sku: string | null } | null;
}

export default function VendorMappingsAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<MappingRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('vendor_item_mappings')
      .select(
        `id, vendor_item_number, vendor_product_number, vendor_description,
         vendor_uom, pack_qty, conversion_factor, match_source, confidence_score,
         vendor:suppliers!vendor_id (name),
         item:inventory_items!item_id (name, sku)`,
      )
      .eq('organization_id', orgId)
      .order('approved_at', { ascending: false })
      .limit(200);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const v = r.vendor as { name: string | null } | { name: string | null }[] | null;
        const i = r.item as { name: string | null; sku: string | null } | { name: string | null; sku: string | null }[] | null;
        return {
          id: r.id as string,
          vendor_item_number: (r.vendor_item_number as string | null) ?? null,
          vendor_product_number: (r.vendor_product_number as string | null) ?? null,
          vendor_description: (r.vendor_description as string | null) ?? null,
          vendor_uom: (r.vendor_uom as string | null) ?? null,
          pack_qty: r.pack_qty != null ? Number(r.pack_qty) : null,
          conversion_factor: r.conversion_factor != null ? Number(r.conversion_factor) : null,
          match_source: r.match_source as string,
          confidence_score: r.confidence_score != null ? Number(r.confidence_score) : null,
          vendor: Array.isArray(v) ? v[0] ?? null : v,
          item: Array.isArray(i) ? i[0] ?? null : i,
        };
      }),
    );
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
        eyebrow="ADMIN · VENDOR MAPPINGS"
        title="Restricted"
        italic="access."
        emptyIcon={Layers}
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
      eyebrow={`ADMIN · ${rows.length} MAPPINGS`}
      title="Vendor"
      italic="mappings."
      emptyTitle="No mappings yet."
      emptyBody="Vendor item numbers learn the mapping to your internal items the first time a PO is imported. Manual mappings can be added on the web."
      emptyIcon={Layers}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(m) => m.id}
      renderItem={(m) => <MappingCard mapping={m} />}
    />
  );
}

function MappingCard({ mapping }: { mapping: MappingRow }) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
            — {mapping.vendor?.name ?? 'Unknown vendor'}
          </Mono>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
            <Mono size={14} tracking={0.01} color={c.ink}>
              {mapping.vendor_item_number ?? mapping.vendor_product_number ?? '?'}
            </Mono>
            <Body size={12} color={c.ink4}>
              →
            </Body>
            <Mono size={12} tracking={0.01} color={c.ink3}>
              {mapping.item?.sku ?? '—'}
            </Mono>
          </View>
          <Body size={13} color={c.ink2} style={{ marginTop: 4, fontFamily: FONT.displayRegular }} numberOfLines={2}>
            {mapping.item?.name ?? mapping.vendor_description ?? 'Unmapped'}
          </Body>
          {mapping.vendor_uom || mapping.pack_qty ? (
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {[mapping.vendor_uom, mapping.pack_qty ? `pack ${mapping.pack_qty}` : null]
                .filter(Boolean)
                .join(' · ')}
              {mapping.conversion_factor ? ` · ×${mapping.conversion_factor}` : ''}
            </Mono>
          ) : null}
        </View>
        <Pill status={mapping.match_source === 'manual' ? 'ok' : 'default'}>
          {mapping.match_source.toUpperCase()}
        </Pill>
      </View>
    </Card>
  );
}
