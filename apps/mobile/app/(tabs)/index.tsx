import { useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface Summary {
  itemCount: number;
  outOfStockCount: number;
  inventoryValue: number;
  lowStockCount: number;
}

export default function Home() {
  const router = useRouter();
  const { user } = useAuth();
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [orgName, setOrgName] = React.useState<string>('Your workspace');
  const [refreshing, setRefreshing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!user) return;
    const { data: member } = await supabase
      .from('organization_members')
      .select('organization_id, organizations:organization_id (name)')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle();
    if (!member) return;

    const orgId = member.organization_id as string;
    const orgsField = (member as { organizations?: unknown }).organizations;
    const orgObj = Array.isArray(orgsField) ? orgsField[0] : orgsField;
    setOrgName(((orgObj as { name?: string } | null)?.name as string | undefined) ?? 'Workspace');

    const [{ count: itemCount }, { count: outOfStockCount }, valueRpc, lowRpc] = await Promise.all([
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
        .is('deleted_at', null),
      supabase.rpc('inventory_value', { p_org_id: orgId }),
      supabase.rpc('low_stock_count', { p_org_id: orgId }),
    ]);

    setSummary({
      itemCount: itemCount ?? 0,
      outOfStockCount: outOfStockCount ?? 0,
      inventoryValue: typeof valueRpc.data === 'number' ? valueRpc.data : 0,
      lowStockCount: typeof lowRpc.data === 'number' ? lowRpc.data : 0,
    });
    setLoading(false);
  }, [user]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.text} />}
      >
        <Text style={styles.eyebrow}>Welcome back</Text>
        <Text style={styles.title}>{orgName}</Text>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: space.xl }} />
        ) : (
          <>
            <View style={styles.grid}>
              <Stat label="Items" value={summary?.itemCount ?? 0} />
              <Stat label="Value" value={`$${(summary?.inventoryValue ?? 0).toFixed(0)}`} />
              <Stat label="Low stock" value={summary?.lowStockCount ?? 0} tone="warning" />
              <Stat label="Out of stock" value={summary?.outOfStockCount ?? 0} tone="destructive" />
            </View>

            <View style={styles.cta}>
              <Text style={styles.ctaTitle}>Scan to adjust stock</Text>
              <Text style={styles.ctaBody}>
                Tap the scan tab to use your camera. Stock changes log to the same ledger as the web app.
              </Text>
            </View>

            <Pressable
              style={styles.linkCta}
              onPress={() => router.push('/bundles')}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.linkCtaTitle}>Bundles</Text>
                <Text style={styles.linkCtaBody}>
                  Distribute kits, scan against pre-assembled stock, or queue
                  distribution for offline use.
                </Text>
              </View>
              <Text style={styles.linkCtaChev}>›</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'warning' | 'destructive';
}) {
  const color = tone === 'warning' ? theme.warning : tone === 'destructive' ? theme.destructive : theme.text;
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  eyebrow: { color: theme.primary, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', marginTop: space.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.xl },
  stat: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: theme.border,
  },
  statLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { color: theme.text, fontSize: 24, fontWeight: '700', marginTop: 4 },
  cta: {
    marginTop: space.xl,
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  ctaTitle: { color: theme.text, fontSize: 16, fontWeight: '600' },
  ctaBody: { color: theme.textMuted, fontSize: 13, marginTop: space.xs, lineHeight: 18 },
  linkCta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  linkCtaTitle: { color: theme.text, fontSize: 16, fontWeight: '600' },
  linkCtaBody: { color: theme.textMuted, fontSize: 13, marginTop: space.xs, lineHeight: 18 },
  linkCtaChev: { color: theme.textMuted, fontSize: 22, marginLeft: space.sm },
});
