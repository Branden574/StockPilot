import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  Camera,
  Menu,
  Search,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui/card';
import { MintWash } from '@/components/ui/mint-wash';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { StockBar } from '@/components/ui/stock-bar';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface OpenPo {
  id: string;
  po_number: string;
  status: string;
  supplier_name: string | null;
  total: number;
  destination_warehouse_id: string | null;
  expected_at: string | null;
  updated_at: string;
}

const RECEIVABLE_STATUSES = ['expected_inbound', 'ordered', 'partially_received'];

export default function Receive() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { c } = useTheme();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [pos, setPos] = React.useState<OpenPo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setOrgId((data?.organization_id as string | undefined) ?? null));
  }, [user]);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data, error } = await supabase
      .from('purchase_orders')
      .select(
        `id, po_number, status, total, expected_at, updated_at,
         supplier:suppliers!supplier_id (name),
         destination:locations!destination_location_id (warehouse_id)`,
      )
      .eq('organization_id', orgId)
      .in('status', RECEIVABLE_STATUSES)
      .order('updated_at', { ascending: false });
    if (error) {
      console.warn('po list', error);
      setPos([]);
      return;
    }
    const flat: OpenPo[] = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const supplier = r.supplier as { name: string } | { name: string }[] | null;
      const dest = r.destination as { warehouse_id: string | null } | { warehouse_id: string | null }[] | null;
      const supplierObj = Array.isArray(supplier) ? supplier[0] : supplier;
      const destObj = Array.isArray(dest) ? dest[0] : dest;
      return {
        id: r.id as string,
        po_number: r.po_number as string,
        status: r.status as string,
        supplier_name: supplierObj?.name ?? null,
        total: Number(r.total) || 0,
        destination_warehouse_id: destObj?.warehouse_id ?? null,
        expected_at: (r.expected_at as string | null) ?? null,
        updated_at: r.updated_at as string,
      };
    });
    setPos(flat);
  }, [orgId]);

  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        await load();
        if (!cancelled) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function open(po: OpenPo) {
    if (!po.destination_warehouse_id) return;
    router.push(`/po/${po.id}`);
  }

  const overdueCount = pos.filter((p) => {
    if (!p.expected_at) return false;
    return new Date(p.expected_at) < new Date();
  }).length;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={Menu} onPress={openDrawer} />
          <IconChip icon={Search} />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`${pos.length} OPEN${overdueCount > 0 ? ` · ${overdueCount} OVERDUE` : ''}`}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Receive <Em>POs.</Em>
          </Display>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          <Pressable
            onPress={() => router.push('/scan-po')}
            style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
          >
            <Card hero style={styles.aiCard}>
              <View pointerEvents="none" style={styles.washPos}>
                <MintWash width={140} height={140} intensity={0.2} />
              </View>
              <View
                style={[
                  styles.cameraWell,
                  { backgroundColor: c.paper2, borderColor: c.hair },
                ]}
              >
                <Camera size={30} color={c.ink} strokeWidth={1.5} />
                <View style={[styles.mintPip, { backgroundColor: ACCENT.mint }]} />
              </View>
              <View style={{ flex: 1, position: 'relative' }}>
                <Eyebrow>AI · BETA</Eyebrow>
                <Mono
                  size={16}
                  tracking={-0.012}
                  color={c.ink}
                  style={{ fontFamily: FONT.display, marginTop: 6 }}
                >
                  Scan packing slip <Em>with AI</Em>
                </Mono>
                <Body muted size={12.5} style={{ marginTop: 4 }}>
                  30 seconds, no manual entry
                </Body>
              </View>
            </Card>
          </Pressable>
        </View>

        <View style={styles.sectionHead}>
          <Eyebrow>OPEN PURCHASE ORDERS</Eyebrow>
          <Body size={12} muted>
            Sort · ETA
          </Body>
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={pos}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Display size={18}>Nothing to receive.</Display>
              <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                When a PO is approved on the web, it&apos;ll appear here ready to scan and receive.
              </Body>
            </View>
          }
          renderItem={({ item }) => <POCard po={item} onPress={() => open(item)} />}
        />
      )}
    </View>
  );
}

function statusForPo(s: string): { label: string; status: 'ok' | 'warn' | 'default' } {
  if (s === 'expected_inbound') return { label: 'EXPECTED', status: 'default' };
  if (s === 'ordered') return { label: 'ORDERED', status: 'default' };
  if (s === 'partially_received') return { label: 'PARTIAL', status: 'warn' };
  return { label: s.toUpperCase(), status: 'default' };
}

function POCard({ po, onPress }: { po: OpenPo; onPress: () => void }) {
  const { c } = useTheme();
  const meta = statusForPo(po.status);
  const isPartial = po.status === 'partially_received';
  const etaText = po.expected_at
    ? new Date(po.expected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '—';

  return (
    <Pressable
      onPress={onPress}
      disabled={!po.destination_warehouse_id}
      style={({ pressed }) => ({
        opacity: pressed ? 0.85 : po.destination_warehouse_id ? 1 : 0.55,
      })}
    >
      <Card padding={16}>
        <View style={poStyles.headerRow}>
          <View style={{ flex: 1 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              — {po.supplier_name ?? 'No supplier'}
            </Mono>
            <Mono
              size={17}
              tracking={0.01}
              color={c.ink}
              style={{ marginTop: 6 }}
            >
              {po.po_number}
            </Mono>
          </View>
          {meta.status === 'default'
            ? <Pill>{meta.label}</Pill>
            : <Pill status={meta.status}>{meta.label}</Pill>}
        </View>

        <View style={poStyles.statRow}>
          <SmallStat label="TOTAL" value={`$${po.total.toFixed(0)}`} />
          <SmallStat label="ETA" value={etaText} mono />
        </View>

        {isPartial ? (
          <View style={{ marginTop: 12 }}>
            <StockBar value={47} max={100} kind="warn" />
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 6 }}>
              partial receipt in progress
            </Mono>
          </View>
        ) : null}

        {!po.destination_warehouse_id ? (
          <Mono size={11} color={ACCENT.warn} style={{ marginTop: 8 }}>
            Set destination on web before receiving
          </Mono>
        ) : null}
      </Card>
    </Pressable>
  );
}

function SmallStat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ minWidth: 0 }}>
      <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
        {label}
      </Mono>
      <Mono
        size={15}
        tracking={mono ? 0.02 : -0.012}
        color={c.ink}
        style={{
          marginTop: 4,
          fontFamily: mono ? FONT.mono : FONT.display,
        }}
      >
        {value}
      </Mono>
    </View>
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
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  aiCard: {
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  washPos: { position: 'absolute', top: -30, right: -30 },
  cameraWell: {
    width: 64,
    height: 64,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
  },
  mintPip: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sectionHead: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  empty: { padding: 32, alignItems: 'center' },
});

const poStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  statRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 24,
  },
});
