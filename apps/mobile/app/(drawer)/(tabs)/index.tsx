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
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from 'expo-router/js-tabs';

import {
  collectLegacyRefIdsByKind,
  movementReasonTeaser,
  orderNumberLabels,
  returnNumberLabels,
} from '@stockpilot/core';

import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip, Row } from '@/components/ui/row';
import { StatCard } from '@/components/ui/stat-card';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useAuth } from '@/lib/auth-context';
import { HOME_BUNDLES_SUBTITLE } from '@/lib/cta-gating';
import { useSyncStatus } from '@/lib/cycle-count-sync';
import { homeGreeting, nextDayPartChange } from '@/lib/greeting';
import { useProfile } from '@/lib/use-profile';
import { supabase } from '@/lib/supabase';
import { syncBadgeState } from '@/lib/sync-badge';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace, useWorkspace } from '@/lib/use-workspace';
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

/** A head-count read's answer (supabase-js answers errors, it does not throw them). */
interface CountRead {
  count: number | null;
  error: unknown;
}

/** An RPC read's answer. */
interface RpcRead {
  data: unknown;
  error: unknown;
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

/**
 * Said in place of the four figures when a read behind them failed, or when
 * there is no workspace to read them for. The Reports screen says the same
 * words over the same four figures (core BOOK_REPORT_KPI_LOAD_ERROR).
 */
const FIGURES_LOAD_ERROR = "Couldn't load these figures. Pull to refresh.";

/** Said in place of the recent movements when their read failed. */
const RECENT_LOAD_ERROR = "Couldn't load recent movements. Pull to refresh.";

/**
 * The four figures from the five reads that make them, or null when any of
 * those reads failed: a figure that was not read is never shown as 0
 * (redesign defect D26). A pure function of the answers, so the test runs it.
 */
function homeSummary(
  items: CountRead,
  out: CountRead,
  valueRpc: RpcRead,
  lowRpc: RpcRead,
  flaggedLow: CountRead,
): Summary | null {
  if ([items, out, valueRpc, lowRpc, flaggedLow].some((read) => read.error)) return null;
  return {
    itemCount: items.count ?? 0,
    outOfStockCount: out.count ?? 0,
    inventoryValue: typeof valueRpc.data === 'number' ? valueRpc.data : 0,
    lowStockCount: Math.max(
      0,
      (typeof lowRpc.data === 'number' ? lowRpc.data : 0) - (flaggedLow.count ?? 0),
    ),
  };
}

/**
 * Home: the phone's overview, on the redesign's per-mode palette.
 *
 * What it says is read, never written in: the four figures (with a
 * failed-read state instead of zeros), the sync engine's own words beside the
 * workspace name (the sync badge's words, lib/sync-badge.ts; it used to say
 * "synced now" whatever the queue held), and no decorative sparklines (they
 * were fixed arrays, not data). Tour target, links and refresh rules are as
 * they were.
 */
export default function Home() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { activeOrgId, activeOrgName, loading: workspaceLoading } = useWorkspace();
  const { c } = useTheme();
  const profile = useProfile();
  const tabBarHeight = useBottomTabBarHeight();
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const scanTargetRef = useTourTarget('home-scan');
  const [recent, setRecent] = React.useState<RecentMovement[]>([]);
  // The recent-movements read failed: said, never "No stock movements yet."
  const [recentFailed, setRecentFailed] = React.useState(false);
  // Derived, not stored: the header label IS the workspace switcher's active
  // org name. It used to be useState set synchronously at the top of load(),
  // which is the same value one render late (with the same fallbacks).
  const orgName = user && activeOrgId ? activeOrgName ?? 'Workspace' : 'Your workspace';
  const [refreshing, setRefreshing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [unread, setUnread] = React.useState(0);
  // The sync engine's state, in the words the sync badge uses.
  const sync = syncBadgeState(useSyncStatus());
  // The phone's clock, for the greeting and the date line. Home stays mounted
  // behind the other tabs, so a clock read once would keep greeting by the
  // morning all day: it is read again whenever Home comes back into
  // focus, whenever the app comes back to the foreground, on Refresh, and,
  // while Home is open, at noon, 5 PM and midnight (a Home screen left open,
  // such as a shared tablet that never sleeps, keeps up). The timer stops
  // when Home loses focus; in the background iOS pauses it, and coming back
  // reads the clock anyway.
  const [now, setNow] = React.useState(() => new Date());
  useFocusEffect(
    React.useCallback(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const readClock = () => {
        const current = new Date();
        setNow(current);
        // A second past the change, so the clock read is on the far side of it.
        timer = setTimeout(readClock, nextDayPartChange(current).getTime() - current.getTime() + 1000);
      };
      readClock();
      return () => clearTimeout(timer);
    }, []),
  );
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => sub.remove();
  }, []);

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

    try {
      const [items, out, valueRpc, lowRpc, flaggedLow, movements] = await Promise.all([
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

      // Every figure's reads must have answered: one failure is "couldn't
      // load", never a zero standing in for a number that was not read.
      setSummary(homeSummary(items, out, valueRpc, lowRpc, flaggedLow));
      setRecentFailed(Boolean(movements.error));
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
              // in-list-bound: legacy refs from the 3 movements this teaser reads (.limit(3))
              .in('id', legacyRefIds.order_request)
          : Promise.resolve({ data: [] as { id: string; order_number: number | null }[] }),
        legacyRefIds.return.length > 0
          ? supabase
              .from('returns')
              .select('id, return_number')
              .eq('organization_id', orgId)
              // in-list-bound: legacy refs from the 3 movements this teaser reads (.limit(3))
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
    } catch {
      // The reads answer their errors rather than throwing; anything that
      // still throws is a failed read too, and must not leave the spinner on.
      setSummary(null);
      setRecentFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, activeOrgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    load();
  }, [load]);

  async function onRefresh() {
    setNow(new Date());
    setRefreshing(true);
    try {
      // No workspace (a launch offline): ask for it again; its arrival loads.
      if (activeOrgId) await Promise.all([load(), refreshUnread()]);
      else await retryWorkspace();
    } finally {
      setRefreshing(false);
    }
  }

  // Without a workspace, once loading it has ended, nothing can be read: the
  // figures and the movements say so instead of a spinner that never stops.
  const noWorkspace = !activeOrgId && !workspaceLoading;
  const figures = noWorkspace ? null : summary;
  const recentUnavailable = noWorkspace || recentFailed;

  const dateLabel = `TODAY · ${SHORT_DAY[now.getDay()].toUpperCase()} ${SHORT_MONTH[now.getMonth()].toUpperCase()} ${now.getDate()}`;
  const firstName = (profile.fullName ?? '').split(/\s+/)[0]
    || (user?.email ? user.email.split('@')[0] : 'there');
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  // A sync problem is said in its tone; every other state in the muted ink.
  const syncColor =
    sync.tone === 'destructive' ? c.critText : sync.tone === 'warning' ? c.warnText : c.ink3;

  const fmtCurrency = (n: number): { value: string; unit: string } => {
    if (n >= 1_000_000) return { value: `$${(n / 1_000_000).toFixed(1)}`, unit: 'M' };
    if (n >= 1_000) return { value: `$${(n / 1_000).toFixed(1)}`, unit: 'K' };
    return { value: `$${n.toFixed(0)}`, unit: '' };
  };
  const value = fmtCurrency(figures?.inventoryValue ?? 0);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
            <Avatar
              size={38}
              onPress={() => router.push('/settings')}
              accessibilityLabel="Account settings"
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 2 }}>
            <IconChip
              icon={Bell}
              badge={unread}
              onPress={() => router.push('/notifications')}
              accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
              minTap
            />
            <IconChip icon={RefreshCcw} onPress={onRefresh} accessibilityLabel="Refresh" minTap />
          </View>
        </View>
        <View style={styles.head}>
          <Eyebrow>{dateLabel}</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            {homeGreeting(now)}{'\n'}
            <Em>{firstName}.</Em>
          </Display>
          <Mono size={13.5} tracking={0.02} color={c.ink3} style={{ marginTop: 10 }}>
            {orgName} ·{' '}
            <Mono size={13.5} tracking={0.02} color={syncColor}>
              {sync.label}
            </Mono>
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
        {loading && !noWorkspace ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
        ) : (
          <>
            {figures ? (
              <View style={styles.statGrid}>
                <View style={styles.statCol}>
                  <StatCard
                    label="ITEMS"
                    value={figures.itemCount.toLocaleString()}
                    unit="SKUs"
                  />
                </View>
                <View style={styles.statCol}>
                  <StatCard label="VALUE" value={value.value} unit={value.unit} />
                </View>
                <View style={styles.statCol}>
                  <StatCard
                    label="LOW"
                    value={figures.lowStockCount.toLocaleString()}
                    unit="SKUs"
                  />
                </View>
                <View style={styles.statCol}>
                  <StatCard
                    label="OUT"
                    value={figures.outOfStockCount.toLocaleString()}
                    unit="SKUs"
                  />
                </View>
              </View>
            ) : (
              // Where the four figures sit: said, never four zeros.
              <View style={styles.figuresFailed}>
                <Card padding={16}>
                  <Body size={14.5} accessibilityRole="alert">
                    {FIGURES_LOAD_ERROR}
                  </Body>
                </Card>
              </View>
            )}

            <View ref={scanTargetRef} collapsable={false} style={{ paddingHorizontal: 20, marginTop: 20 }}>
              <Pressable
                onPress={() => router.push('/scan')}
                accessibilityRole="button"
                style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
              >
                <Card hero style={styles.scanCard}>
                  <Eyebrow>QUICK ADJUST</Eyebrow>
                  <Display size={22} style={{ marginTop: 10 }}>
                    Scan to <Em>adjust stock.</Em>
                  </Display>
                  <Body muted style={{ marginTop: 8 }}>
                    Point at a barcode, QR, or rack tag. Stock moves before you put the phone down.
                  </Body>
                  <View style={styles.scanCtaRow}>
                    <View style={[styles.barWell, { backgroundColor: c.sunk, borderColor: c.hair }]}>
                      <Barcode size={28} color={c.ink} strokeWidth={1.6} />
                      <View style={[styles.accentPip, { backgroundColor: c.accent }]} />
                    </View>
                    {/* The ink button's look (a View: the whole card is the
                        one target, so no button sits inside it). */}
                    <View style={[styles.openScanCta, { backgroundColor: c.ink }]}>
                      <Text
                        style={[styles.openScanLabel, { color: c.paper }]}
                        numberOfLines={1}
                        maxFontSizeMultiplier={OPEN_SCANNER_CAP}
                      >
                        Open scanner →
                      </Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Eyebrow>RECENT MOVEMENTS</Eyebrow>
                <Pressable
                  onPress={() => router.push('/movements')}
                  accessibilityRole="button"
                  accessibilityLabel="See all movements"
                  style={({ pressed }) => [styles.seeAll, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Mono size={11} tracking={0.06} color={c.accent}>
                    See all
                  </Mono>
                </Pressable>
              </View>
              {recentUnavailable ? (
                <Card padding={18}>
                  <Body size={14.5} accessibilityRole="alert">
                    {RECENT_LOAD_ERROR}
                  </Body>
                </Card>
              ) : recent.length === 0 ? (
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

            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Eyebrow>BUNDLES</Eyebrow>
              </View>
              <Pressable
                onPress={() => router.push('/bundles')}
                accessibilityRole="button"
                style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
              >
                <Card>
                  <Row
                    leading={<Thumb size={40} icon={Link2} pip={c.accent} />}
                    title="Bundles"
                    subtitle={HOME_BUNDLES_SUBTITLE}
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
  // The per-mode tones: accent in, refusal red out, warning for a zero change.
  const pipColor = isAdd ? c.accent : isSub ? c.critText : c.warnText;
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
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.miniRow,
        { borderBottomColor: c.hair, borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0 },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.miniTime}>
        <Mono size={11} tracking={0.04} color={c.ink3}>
          {time}
        </Mono>
        <View style={[styles.miniPip, { backgroundColor: pipColor }]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={14.5} color={c.ink} numberOfLines={1} style={{ fontFamily: FONT.display }}>
          {m.itemName}
        </Body>
        <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 2 }}>
          {verb}
          {reason ? ` · ${reason}` : ''}
        </Mono>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
        <Icon size={12} color={c.ink3} strokeWidth={1.8} />
        <Mono
          size={15}
          tracking={-0.012}
          color={isAdd ? c.accent : isSub ? c.critText : c.ink}
          style={{ fontFamily: FONT.display }}
        >
          {isAdd ? '+' : ''}
          {m.quantityChange}
        </Mono>
      </View>
    </Pressable>
  );
}

/** "Open scanner →" is a button's label: the control ceiling, as Button's. */
const OPEN_SCANNER_CAP = capTo(15.5, TYPE_CEILING.control);

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 20,
    marginTop: 22,
  },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  // See all: a 44pt frame around the same 11pt words; the negative margin
  // gives the frame's extra height back, so the heading row keeps its height.
  seeAll: {
    minHeight: 44,
    minWidth: 44,
    marginVertical: -15,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  miniRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
  },
  // minWidth, not width: the time is uncapped content and grows with the text
  // size instead of being cut at 46pt.
  miniTime: {
    minWidth: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniPip: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  // The chips' 44pt frames (IconChip minTap) and the avatar's (Avatar with
  // onPress) are 3pt wider than the 38pt chip or picture on every side, so
  // the bar takes 3pt off its padding (12, 8), the gap between two frames 6pt
  // (8 -> 2, the menu chip to the avatar too) and the head 3pt off its top:
  // the chips, the avatar and the greeting sit where they did.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 9,
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
  figuresFailed: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  scanCard: {
    padding: 22,
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
  accentPip: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  // The shared button's md recipe (components/ui/button.tsx): radius 14, the
  // label on one line, and minHeight so a larger label grows the box.
  openScanCta: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openScanLabel: {
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 15.5,
    letterSpacing: -0.15,
  },
});
