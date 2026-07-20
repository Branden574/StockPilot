import { useNavigation } from 'expo-router';
import {
  ArrowUpRight,
  BarChart3,
  Menu,
  Package,
  PackageX,
  TrendingDown,
  TrendingUp,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';

import { Card } from '@/components/ui/card';
import { MintWash } from '@/components/ui/mint-wash';
import { IconChip } from '@/components/ui/row';
import { StatCard } from '@/components/ui/stat-card';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface ReportSummary {
  itemCount: number;
  outOfStockCount: number;
  inventoryValue: number;
  lowStockCount: number;
  thirtyDayMovements: number;
}

/**
 * Reports & insights screen. Lives in src/screens so two thin routes can
 * render the same component: the drawer destination app/(drawer)/reports.tsx
 * and the optional bottom tab app/(drawer)/(tabs)/reports-tab.tsx (Settings →
 * Customize tab bar). BottomTabBarHeightContext is undefined outside a tabs
 * navigator, so the extra scroll inset applies only in the tab rendering —
 * the drawer rendering is byte-for-byte today's layout.
 */
export default function ReportsScreen() {
  const { c } = useTheme();
  const { orgId } = useOrg();
  const navigation = useNavigation();
  // 0 in the drawer; the translucent bar height inside the tabs navigator.
  const tabBarInset = React.useContext(BottomTabBarHeightContext) ?? 0;
  const [summary, setSummary] = React.useState<ReportSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: itemCount }, { count: outCount }, valueRpc, lowRpc, { count: moves }] =
      await Promise.all([
        supabase
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .eq('status', 'active')
          .is('deleted_at', null),
        supabase
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .eq('status', 'active')
          .lte('quantity_on_hand', 0)
          // Expected-items visibility (mig 0277): a PO-created item awaiting
          // its FIRST receipt was never in stock, so it must not count as
          // "out of stock" (web dashboard widgets apply the same predicate).
          .eq('awaiting_first_receipt', false)
          .is('deleted_at', null),
        supabase.rpc('inventory_value', { p_org_id: orgId }),
        supabase.rpc('low_stock_count', { p_org_id: orgId }),
        supabase
          .from('stock_movements')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .gte('created_at', since),
      ]);
    setSummary({
      itemCount: itemCount ?? 0,
      outOfStockCount: outCount ?? 0,
      inventoryValue: typeof valueRpc.data === 'number' ? valueRpc.data : 0,
      lowStockCount: typeof lowRpc.data === 'number' ? lowRpc.data : 0,
      thirtyDayMovements: moves ?? 0,
    });
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

  const fmt = (n: number): { value: string; unit: string } => {
    if (n >= 1_000_000) return { value: `$${(n / 1_000_000).toFixed(1)}`, unit: 'M' };
    if (n >= 1_000) return { value: `$${(n / 1_000).toFixed(1)}`, unit: 'K' };
    return { value: `$${n.toFixed(0)}`, unit: '' };
  };
  const value = fmt(summary?.inventoryValue ?? 0);
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={Menu} onPress={openDrawer} />
        </View>
        <View style={styles.head}>
          <Eyebrow>ANALYTICS</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Reports <Em>& insights.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 12, paddingBottom: 40 + tabBarInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
      >
        {loading || !summary ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: 40 }} />
        ) : (
          <>
            <View style={styles.grid}>
              <View style={styles.col}>
                <StatCard
                  label="ITEMS"
                  value={summary.itemCount.toLocaleString()}
                  unit="SKUs"
                  spark={[3, 4, 4, 5, 4.5, 5, 6]}
                  sparkKind="ok"
                />
              </View>
              <View style={styles.col}>
                <StatCard
                  label="VALUE"
                  value={value.value}
                  unit={value.unit}
                  spark={[4, 5, 4.8, 6, 5.5, 6.2, 7]}
                  sparkKind="ok"
                />
              </View>
              <View style={styles.col}>
                <StatCard
                  label="LOW"
                  value={summary.lowStockCount.toLocaleString()}
                  unit="SKUs"
                  spark={[2, 3, 5, 4, 6, 7, 9]}
                  sparkKind="warn"
                />
              </View>
              <View style={styles.col}>
                <StatCard
                  label="OUT"
                  value={summary.outOfStockCount.toLocaleString()}
                  unit="SKUs"
                  spark={[3, 2, 4, 3, 2, 2, 4]}
                  sparkKind="crit"
                />
              </View>
            </View>

            <Card hero style={styles.activityCard}>
              <View pointerEvents="none" style={styles.washPos}>
                <MintWash width={200} height={200} intensity={0.2} />
              </View>
              <Eyebrow>LAST 30 DAYS</Eyebrow>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
                <Mono size={44} tracking={-0.025} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {summary.thirtyDayMovements.toLocaleString()}
                </Mono>
                <Mono size={13} color={c.ink4} tracking={0.04}>
                  movements
                </Mono>
              </View>
              <Body muted style={{ marginTop: 4 }}>
                Receives, adjusts, transfers, returns posted to the ledger.
              </Body>
              <Pressable
                onPress={() => Linking.openURL('https://stockpilotusa.com/dashboard/reports').catch(() => undefined)}
                style={({ pressed }) => ({
                  marginTop: 16,
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: c.hair,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Mono size={11.5} tracking={0.08} upper color={c.ink}>
                  Full report on web
                </Mono>
                <ArrowUpRight size={14} color={c.ink} strokeWidth={1.6} />
              </Pressable>
            </Card>

            <View style={{ marginTop: 20, gap: 10 }}>
              <ReportRow
                icon={TrendingUp}
                title="Inventory health"
                value={`${Math.max(0, 100 - Math.round((summary.lowStockCount / Math.max(1, summary.itemCount)) * 100))}%`}
                tone="ok"
              />
              <ReportRow
                icon={TrendingDown}
                title="Stockout exposure"
                value={`${summary.outOfStockCount} ${summary.outOfStockCount === 1 ? 'SKU' : 'SKUs'}`}
                tone={summary.outOfStockCount === 0 ? 'ok' : 'crit'}
              />
              <ReportRow
                icon={Package}
                title="Avg value / SKU"
                value={fmt(summary.itemCount > 0 ? summary.inventoryValue / summary.itemCount : 0).value + fmt(summary.itemCount > 0 ? summary.inventoryValue / summary.itemCount : 0).unit}
                tone="default"
              />
              <ReportRow
                icon={PackageX}
                title="Below reorder"
                value={`${summary.lowStockCount} ${summary.lowStockCount === 1 ? 'SKU' : 'SKUs'}`}
                tone={summary.lowStockCount === 0 ? 'ok' : 'warn'}
              />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ReportRow({
  icon: Icon,
  title,
  value,
  tone = 'default',
}: {
  icon: typeof BarChart3;
  title: string;
  value: string;
  tone?: 'ok' | 'warn' | 'crit' | 'default';
}) {
  const { c } = useTheme();
  const tint = tone === 'ok' ? ACCENT.mint : tone === 'warn' ? ACCENT.warn : tone === 'crit' ? ACCENT.crit : c.ink3;
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            backgroundColor: c.card,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <Icon size={16} color={c.ink} strokeWidth={1.5} />
          <View
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: tint,
            }}
          />
        </View>
        <Body size={15} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
          {title}
        </Body>
        <Mono size={15} tracking={-0.012} color={c.ink} style={{ fontFamily: FONT.display }}>
          {value}
        </Mono>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  col: { flexBasis: '48%', flexGrow: 1 },
  activityCard: {
    marginTop: 20,
    padding: 22,
    overflow: 'hidden',
    position: 'relative',
  },
  washPos: { position: 'absolute', top: -50, right: -50 },
});
