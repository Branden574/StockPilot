import { Truck } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

/**
 * Suppliers screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/suppliers.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/suppliers-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function SuppliersScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<SupplierRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('suppliers')
      .select('id, name, contact_name, email, phone, website')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('name', { ascending: true });
    setRows((data ?? []) as SupplierRow[]);
    setLoading(false);
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <DataListScreen
      eyebrow={`DIRECTORY · ${rows.length} SUPPLIERS`}
      title="Suppliers"
      italic="& carriers."
      emptyTitle="No suppliers yet."
      emptyBody="Add vendors on the web to attach them to purchase orders here."
      emptyIcon={Truck}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(s) => s.id}
      renderItem={(s) => <SupplierCard supplier={s} />}
    />
  );
}

function SupplierCard({ supplier }: { supplier: SupplierRow }) {
  const { c } = useTheme();

  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            backgroundColor: c.card,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Truck size={18} color={c.ink} strokeWidth={1.5} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {supplier.name}
          </Body>
          {supplier.contact_name ? (
            <Mono size={11.5} tracking={0.04} color={c.ink4}>
              {supplier.contact_name}
            </Mono>
          ) : null}
          {supplier.email ? (
            <Pressable onPress={() => Linking.openURL(`mailto:${supplier.email}`).catch(() => undefined)}>
              <Mono size={11.5} tracking={0.04} color={c.ink2}>
                {supplier.email}
              </Mono>
            </Pressable>
          ) : null}
          {supplier.phone ? (
            <Pressable onPress={() => Linking.openURL(`tel:${supplier.phone}`).catch(() => undefined)}>
              <Mono size={11.5} tracking={0.04} color={c.ink2}>
                {supplier.phone}
              </Mono>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
