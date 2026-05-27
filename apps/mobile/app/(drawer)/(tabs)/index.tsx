import { useNavigation, useRouter } from 'expo-router';
import {
  Barcode,
  Bell,
  Link2,
  Menu,
  RefreshCcw,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { MintWash } from '@/components/ui/mint-wash';
import { Pill } from '@/components/ui/pill';
import { IconChip, Row } from '@/components/ui/row';
import { StatCard } from '@/components/ui/stat-card';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useAuth } from '@/lib/auth-context';
import { useProfile } from '@/lib/use-profile';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Summary {
  itemCount: number;
  outOfStockCount: number;
  inventoryValue: number;
  lowStockCount: number;
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Home() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { c } = useTheme();
  const profile = useProfile();
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

  const now = new Date();
  const dateLabel = `TODAY · ${SHORT_DAY[now.getDay()].toUpperCase()} ${SHORT_MONTH[now.getMonth()].toUpperCase()} ${now.getDate()}`;
  const firstName = (profile.fullName ?? '').split(/\s+/)[0]
    || (user?.email ? user.email.split('@')[0] : 'there');
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  const fmtCurrency = (n: number): { value: string; unit: string } => {
    if (n >= 1_000_000) return { value: `$${(n / 1_000_000).toFixed(1)}`, unit: 'M' };
    if (n >= 1_000) return { value: `$${(n / 1_000).toFixed(1)}`, unit: 'K' };
    return { value: `$${n.toFixed(0)}`, unit: '' };
  };
  const value = fmtCurrency(summary?.inventoryValue ?? 0);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip icon={Menu} onPress={openDrawer} />
            <Avatar size={38} onPress={() => router.push('/settings')} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <IconChip icon={Bell} onPress={() => router.push('/notifications')} />
            <IconChip icon={RefreshCcw} onPress={onRefresh} />
          </View>
        </View>
        <View style={styles.head}>
          <Eyebrow>{dateLabel}</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            Good morning,{'\n'}
            <Em>{firstName}.</Em>
          </Display>
          <Mono size={13.5} tracking={0.02} color={c.ink3} style={{ marginTop: 10 }}>
            {orgName} · synced now
          </Mono>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 30 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.ink}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
        ) : (
          <>
            <View style={styles.statGrid}>
              <View style={styles.statCol}>
                <StatCard
                  label="ITEMS"
                  value={(summary?.itemCount ?? 0).toLocaleString()}
                  unit="SKUs"
                  spark={[3, 4, 3.5, 5, 4.5, 6, 7]}
                  sparkKind="ok"
                />
              </View>
              <View style={styles.statCol}>
                <StatCard
                  label="VALUE"
                  value={value.value}
                  unit={value.unit}
                  spark={[4, 5, 4.8, 6, 5.5, 6.2, 7]}
                  sparkKind="ok"
                />
              </View>
              <View style={styles.statCol}>
                <StatCard
                  label="LOW"
                  value={(summary?.lowStockCount ?? 0).toLocaleString()}
                  unit="SKUs"
                  spark={[2, 3, 5, 4, 6, 7, 9]}
                  sparkKind="warn"
                />
              </View>
              <View style={styles.statCol}>
                <StatCard
                  label="OUT"
                  value={(summary?.outOfStockCount ?? 0).toLocaleString()}
                  unit="SKUs"
                  spark={[3, 2, 4, 3, 2, 2, 4]}
                  sparkKind="crit"
                />
              </View>
            </View>

            <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
              <Pressable
                onPress={() => router.push('/scan')}
                style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
              >
                <Card hero style={styles.scanCard}>
                  <View pointerEvents="none" style={styles.washPos}>
                    <MintWash width={200} height={200} intensity={0.22} />
                  </View>
                  <View style={{ position: 'relative' }}>
                    <Eyebrow>QUICK ADJUST</Eyebrow>
                    <Display size={22} style={{ marginTop: 10 }}>
                      Scan to <Em>adjust stock.</Em>
                    </Display>
                    <Body muted style={{ marginTop: 8 }}>
                      Point at a barcode, QR, or rack tag. Stock moves before you put the phone down.
                    </Body>
                    <View style={styles.scanCtaRow}>
                      <View
                        style={[
                          styles.barWell,
                          { backgroundColor: c.paper2, borderColor: c.hair },
                        ]}
                      >
                        <Barcode size={28} color={c.ink} strokeWidth={1.6} />
                        <View style={[styles.mintPip, { backgroundColor: ACCENT.mint }]} />
                      </View>
                      <View style={[styles.openScanCta, { backgroundColor: c.ink }]}>
                        <Mono size={13} tracking={0.04} color={c.paper} style={{ fontFamily: FONT.display }}>
                          Open scanner →
                        </Mono>
                      </View>
                    </View>
                  </View>
                </Card>
              </Pressable>
            </View>

            <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
              <Pressable
                onPress={() => router.push('/bundles')}
                style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
              >
                <Card>
                  <Row
                    leading={
                      <Thumb size={40} icon={Link2} pip={ACCENT.pipTeal} />
                    }
                    title="Bundles"
                    subtitle="Distribute kits & assembled stock"
                    trailing={<Pill status="ok">OPEN</Pill>}
                    chevron
                  />
                </Card>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  statGrid: {
    paddingHorizontal: 20,
    paddingTop: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCol: {
    flexBasis: '48%',
    flexGrow: 1,
  },
  scanCard: {
    padding: 22,
    overflow: 'hidden',
    position: 'relative',
  },
  washPos: {
    position: 'absolute',
    top: -40,
    right: -40,
  },
  scanCtaRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  barWell: {
    width: 56,
    height: 56,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  mintPip: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  openScanCta: {
    flex: 1,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
