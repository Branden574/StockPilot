import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  Barcode,
  Bell,
  Link2,
  Menu,
  Minus,
  Plus,
  RefreshCcw,
  RotateCcw,
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
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';

import {
  collectLegacyRefIdsByKind,
  movementReasonTeaser,
  orderNumberLabels,
  returnNumberLabels,
} from '@stockpilot/core';

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
import { useWorkspace } from '@/lib/use-workspace';
import { MobileTour } from '@/components/onboarding/mobile-tour';
import { useTourTarget } from '@/lib/tour-targets';
import { MOBILE_HOME_TOUR } from '@/lib/onboarding';

interface Summary {
  itemCount: number;
  outOfStockCount: number;
  inventoryValue: number;
  lowStockCount: number;
}

interface RecentMovement {
  id: string;
  itemId: string;
  itemName: string;
  movementType: string;
  quantityChange: number;
  reason: string | null;
  createdAt: string;
}

const MOVEMENT_VERB: Record<string, string> = {
  add: 'Added',
  remove: 'Removed',
  adjust: 'Adjusted',
  transfer: 'Transferred',
  receive_po: 'Received',
  return: 'Returned',
  damage: 'Damaged',
  loss: 'Lost',
  correction: 'Corrected',
  initial: 'Initialized',
};

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Home() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { activeOrgId, activeOrgName } = useWorkspace();
  const { c } = useTheme();
  const profile = useProfile();
  const tabBarHeight = useBottomTabBarHeight();
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const scanTargetRef = useTourTarget('home-scan');
  const [recent, setRecent] = React.useState<RecentMovement[]>([]);
  const [orgName, setOrgName] = React.useState<string>('Your workspace');
  const [refreshing, setRefreshing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [unread, setUnread] = React.useState(0);

  // Unread-notification count for the header bell badge. A cheap head-count
  // query (partial index notifications_user_unread_idx). Kept separate from the
  // dashboard load so it can refresh on focus — the count drops when the user
  // reads notifications and returns to this tab.
  const refreshUnread = React.useCallback(async () => {
    if (!user || !activeOrgId) return;
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', activeOrgId)
      .eq('user_id', user.id)
      .is('read_at', null);
    setUnread(count ?? 0);
  }, [user, activeOrgId]);

  useFocusEffect(
    React.useCallback(() => {
      void refreshUnread();
    }, [refreshUnread]),
  );

  const load = React.useCallback(async () => {
    // Scope to the ACTIVE workspace org — NOT the first membership row. This
    // screen queries Supabase directly (RLS-scoped), so it must read
    // activeOrgId from useWorkspace; the old code grabbed the first
    // organization_members row and ignored the drawer's org switcher entirely
    // (web switched fine, mobile/iPad didn't). Refetches when the org changes
    // because activeOrgId is in this callback's deps.
    if (!user || !activeOrgId) return;
    const orgId = activeOrgId;
    setOrgName(activeOrgName ?? 'Workspace');

    const [{ count: itemCount }, { count: outOfStockCount }, valueRpc, lowRpc, flaggedLow, movements] = await Promise.all([
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
        // "out of stock" (same predicate as inventory.tsx / reports.tsx).
        .eq('awaiting_first_receipt', false)
        .is('deleted_at', null),
      supabase.rpc('inventory_value', { p_org_id: orgId }),
      supabase.rpc('low_stock_count', { p_org_id: orgId }),
      // The low_stock_count RPC (0004) predates mig 0277 and can't exclude
      // awaiting-first-receipt phantoms, so count the flagged slice that
      // matches its predicate (active, not deleted, reorder_point > 0 —
      // flagged rows always sit at qty 0 <= reorder_point) and subtract
      // client-side. Mirrors the reports screen.
      supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('status', 'active')
        .is('deleted_at', null)
        .eq('awaiting_first_receipt', true)
        .gt('reorder_point', 0)
        .lte('quantity_on_hand', 0),
      supabase
        .from('stock_movements')
        .select(
          'id, movement_type, quantity_change, reason, created_at, item_id, item:inventory_items!item_id (name)',
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(3),
    ]);

    setSummary({
      itemCount: itemCount ?? 0,
      outOfStockCount: outOfStockCount ?? 0,
      inventoryValue: typeof valueRpc.data === 'number' ? valueRpc.data : 0,
      lowStockCount: Math.max(
        0,
        (typeof lowRpc.data === 'number' ? lowRpc.data : 0) - (flaggedLow.count ?? 0),
      ),
    });
    // Same batched, org-scoped resolution the Movements screen and every web
    // surface run (packages/core movement-order-ref.ts): a pick/cancel row
    // written before migration 0306 carries the ORDER'S UUID in its reason, and
    // the shipped RMA RPCs still write a return's uuid the same way. Three
    // rows here, so the two lookups are at most two tiny `.in()` queries — and
    // running them is what stops this teaser saying "Order pick" while the web
    // dashboard widget says "Order pick (SO-000060)" about the SAME movement.
    // They are independent, so they run concurrently.
    const movementRows = (movements.data ?? []) as Record<string, unknown>[];
    const legacyRefIds = collectLegacyRefIdsByKind(
      movementRows.map((r) => ({ reason: (r.reason as string | null) ?? null })),
    );
    const [orders, returns] = await Promise.all([
      legacyRefIds.order_request.length > 0
        ? supabase
            .from('order_requests')
            .select('id, order_number')
            .eq('organization_id', orgId)
            .in('id', legacyRefIds.order_request)
        : Promise.resolve({ data: [] as { id: string; order_number: number | null }[] }),
      legacyRefIds.return.length > 0
        ? supabase
            .from('returns')
            .select('id, return_number')
            .eq('organization_id', orgId)
            .in('id', legacyRefIds.return)
        : Promise.resolve({ data: [] as { id: string; return_number: string | null }[] }),
    ]);
    const refLabelById = new Map([
      ...orderNumberLabels((orders.data ?? []) as { id: string; order_number: number | null }[]),
      ...returnNumberLabels((returns.data ?? []) as { id: string; return_number: string | null }[]),
    ]);

    setRecent(
      movementRows.map((r) => {
        const item = r.item as { name?: string } | { name?: string }[] | null;
        const itemObj = Array.isArray(item) ? item[0] ?? null : item;
        return {
          id: r.id as string,
          itemId: r.item_id as string,
          itemName: (itemObj?.name as string | undefined) ?? 'Unknown item',
          movementType: r.movement_type as string,
          quantityChange: Number(r.quantity_change) || 0,
          reason: movementReasonTeaser((r.reason as string | null) ?? null, refLabelById),
          createdAt: r.created_at as string,
        };
      }),
    );
    setLoading(false);
  }, [user, activeOrgId, activeOrgName]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([load(), refreshUnread()]);
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
            <IconChip icon={Bell} badge={unread} onPress={() => router.push('/notifications')} />
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
          <View style={{ marginTop: 12 }}>
            <MobileTour tour={MOBILE_HOME_TOUR} />
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingBottom: tabBarHeight + 24 }}
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

            <View ref={scanTargetRef} collapsable={false} style={{ paddingHorizontal: 20, marginTop: 20 }}>
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

            <View style={{ paddingHorizontal: 20, marginTop: 22 }}>
              <View style={styles.sectionHead}>
                <Eyebrow>RECENT MOVEMENTS</Eyebrow>
                <Pressable
                  onPress={() => router.push('/movements')}
                  hitSlop={10}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Mono size={11} tracking={0.06} color={c.ink3}>
                    See all
                  </Mono>
                </Pressable>
              </View>
              {recent.length === 0 ? (
                <Card padding={18}>
                  <Body muted>
                    No stock movements yet. Scan, count, or receive items to fill this feed.
                  </Body>
                </Card>
              ) : (
                <Card padding={0}>
                  {recent.map((m, i) => (
                    <MovementMiniRow
                      key={m.id}
                      m={m}
                      divider={i < recent.length - 1}
                      onPress={() =>
                        router.push({ pathname: '/item/[id]', params: { id: m.itemId } })
                      }
                    />
                  ))}
                </Card>
              )}
            </View>

            <View style={{ paddingHorizontal: 20, marginTop: 22 }}>
              <View style={styles.sectionHead}>
                <Eyebrow>BUNDLES</Eyebrow>
              </View>
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

function MovementMiniRow({
  m,
  divider,
  onPress,
}: {
  m: RecentMovement;
  divider: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const isAdd = m.quantityChange > 0;
  const isSub = m.quantityChange < 0;
  const Icon = isAdd ? Plus : isSub ? Minus : RotateCcw;
  const pipColor = isAdd ? ACCENT.mint : isSub ? ACCENT.crit : ACCENT.warn;
  const verb = MOVEMENT_VERB[m.movementType] ?? m.movementType;
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // Already resolved and clamped by the loader (packages/core
  // movementReasonTeaser) — the same words the web dashboard widget prints.
  const reason = m.reason;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.miniRow,
        { borderBottomColor: c.hair, borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0 },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.miniTime}>
        <Mono size={11} tracking={0.04} color={c.ink4}>
          {time}
        </Mono>
        <View style={[styles.miniPip, { backgroundColor: pipColor }]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={14.5} color={c.ink} numberOfLines={1} style={{ fontFamily: FONT.display }}>
          {m.itemName}
        </Body>
        <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
          {verb}
          {reason ? ` · ${reason}` : ''}
        </Mono>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
        <Icon size={12} color={c.ink3} strokeWidth={1.8} />
        <Mono
          size={15}
          tracking={-0.012}
          color={isAdd ? ACCENT.mintInk : isSub ? ACCENT.crit : c.ink}
          style={{ fontFamily: FONT.display }}
        >
          {isAdd ? '+' : ''}
          {m.quantityChange}
        </Mono>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 10,
  },
  miniRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
  },
  miniTime: {
    width: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniPip: {
    width: 5,
    height: 5,
    borderRadius: 3,
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
