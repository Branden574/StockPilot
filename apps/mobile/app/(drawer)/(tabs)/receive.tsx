import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, Camera, Menu, TriangleAlert } from 'lucide-react-native';
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
import { useBottomTabBarHeight } from 'expo-router/js-tabs';

import { formatCalendarDate } from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { dataListReloadNote, type DataListFailure } from '@/components/ui/data-list-state';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { readOrgTimeZone } from '@/lib/order-readiness';
import { nextKnownOrgZone, receiveOverdueCount, type KnownOrgZone } from '@/lib/receive-overdue';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
import { FONT } from '@/lib/theme';
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

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "Nothing to receive." (redesign defect D27): it keeps the
 * purchase orders this workspace already shows, marked failed so the screen
 * says so above them, or with none it is the failure itself. Another
 * workspace's purchase orders are never kept.
 */
function settleList<Row>(
  prev: ListState<Row> | null,
  orgId: string,
  rows: Row[] | null,
): ListState<Row> {
  if (rows) return { orgId, rows, failed: false };
  return { orgId, rows: prev && prev.orgId === orgId ? prev.rows : [], failed: true };
}

export default function Receive() {
  const router = useRouter();
  const navigation = useNavigation();
  const { c } = useTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<OpenPo> | null>(null);
  // organizations.timezone, for the OVERDUE count (null: core's default zone).
  const [knownZone, setKnownZone] = React.useState<KnownOrgZone | null>(null);
  const timeZone = knownZone !== null && knownZone.orgId === orgId ? knownZone.zone : null;
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a focus, a pull, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: OpenPo[] | null = null;
    try {
      // The organization's zone is read with the purchase orders, as the order
      // screen reads it: a purchase order is overdue once the ORGANIZATION's
      // date is after its expected day (receiveOverdueCount). The read never
      // throws; unset or refused, it is null.
      const [{ data, error }, zone] = await Promise.all([
        supabase
          .from('purchase_orders')
          .select(
            `id, po_number, status, total, expected_at, updated_at,
             supplier:suppliers!supplier_id (name),
             destination:locations!destination_location_id (warehouse_id)`,
          )
          .eq('organization_id', orgId)
          .in('status', RECEIVABLE_STATUSES)
          .order('updated_at', { ascending: false }),
        readOrgTimeZone(supabase, orgId),
      ]);
      if (seq !== seqRef.current) return;
      // A failed read on a refresh keeps the zone already read (nextKnownOrgZone).
      setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);
      rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const supplier = r.supplier as { name: string } | { name: string }[] | null;
        const dest = r.destination as
          { warehouse_id: string | null } | { warehouse_id: string | null }[] | null;
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
    } catch (e) {
      console.warn('[receive] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
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

  // Only purchase orders read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const pos = React.useMemo(() => list?.rows ?? [], [list]);
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again), never a spinner that waits on nothing.
  const noWorkspace = !orgId && !workspaceLoading;
  const failure: DataListFailure | null = noWorkspace
    ? {
        title: 'Could not load your workspace.',
        body: 'Check your connection and pull down to try again.',
      }
    : list?.failed
      ? {
          title: 'Could not load purchase orders.',
          body: 'Check your connection and pull down to try again.',
          reloadNote: 'Could not refresh the purchase orders. Pull down to try again.',
        }
      : null;
  // Purchase orders an earlier read left on screen stay, under this line.
  const reloadNote = dataListReloadNote(failure, pos.length);
  // The open count is said only once a read has answered for this workspace:
  // before it, or after a read that failed with nothing on screen, "0 OPEN"
  // would be a count nobody took.
  const countKnown = list !== null && !(list.failed && pos.length === 0);

  async function refresh() {
    setRefreshing(true);
    try {
      await (noWorkspace ? retryWorkspace() : load());
    } finally {
      setRefreshing(false);
    }
  }

  function open(po: OpenPo) {
    if (!po.destination_warehouse_id) return;
    router.push(`/po/${po.id}`);
  }

  // Overdue once the organization's date is after the expected DAY, never the
  // stored midnight UTC against this clock (in Los Angeles that counted a
  // purchase order as overdue from 5 PM the evening before its ETA).
  const overdueCount = receiveOverdueCount(pos, new Date(), timeZone);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <IconChip
              icon={ArrowLeft}
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
              accessibilityLabel="Back"
              minTap
            />
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
          </View>
        </View>
        <View style={styles.head}>
          {countKnown ? (
            <Eyebrow>{`${pos.length} OPEN${overdueCount > 0 ? ` · ${overdueCount} OVERDUE` : ''}`}</Eyebrow>
          ) : (
            // Holds the eyebrow's line at every text size, so the title does not
            // move when the count arrives; hidden from VoiceOver, it says nothing.
            <Eyebrow
              prefix=""
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {'\u00a0'}
            </Eyebrow>
          )}
          <Display size={34} style={{ marginTop: 12 }}>
            Receive <Em>POs.</Em>
          </Display>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          <Pressable
            onPress={() => router.push('/scan-po')}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
          >
            <Card hero style={styles.aiCard}>
              {/* The camera sits in a recessed well (sunk: paper2 is the card
                  colour in dark and drew nothing there). */}
              <View style={[styles.cameraWell, { backgroundColor: c.sunk, borderColor: c.hair }]}>
                <Camera size={30} color={c.ink} strokeWidth={1.5} />
                <View style={[styles.mintPip, { backgroundColor: c.accent }]} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
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
          {/* The rows are ordered by when each purchase order last changed
              (updated_at, newest first); the label used to say ETA (D27). */}
          <Body size={12} muted>
            Sort · Recently updated
          </Body>
        </View>
      </SafeAreaView>

      {/* A spinner while a read is out, and until one has answered for the
          workspace on screen (a switch never shows the last one's list). */}
      {loading || (!noWorkspace && list === null) ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={pos}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: tabBarHeight + 24,
            gap: 10,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={c.ink}
            />
          }
          ListHeaderComponent={
            reloadNote ? (
              // Purchase orders from before a reload that failed: said on the
              // warning wash, with the warning glyph beside the words.
              <View style={[styles.reloadNote, { backgroundColor: c.warnWash }]}>
                <TriangleAlert
                  size={16}
                  color={c.warnText}
                  strokeWidth={1.75}
                  style={{ marginTop: 2 }}
                />
                <Body size={13.5} color={c.warnText} accessibilityRole="alert" style={{ flex: 1 }}>
                  {reloadNote}
                </Body>
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            failure ? (
              // The read failed: its own words, never "Nothing to receive." (D27).
              <View style={styles.empty}>
                <View style={{ marginBottom: 12 }}>
                  <TriangleAlert size={32} color={c.warnText} strokeWidth={1.3} />
                </View>
                <Display size={18} accessibilityRole="alert" style={{ textAlign: 'center' }}>
                  {failure.title}
                </Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                  {failure.body}
                </Body>
              </View>
            ) : (
              <View style={styles.empty}>
                <Display size={18}>Nothing to receive.</Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                  When a PO is approved on the web, it&apos;ll appear here ready to scan and
                  receive.
                </Body>
              </View>
            )
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
  // A DAY stored as its UTC midnight: read in UTC, or every US zone shows the
  // day before. A dash when there is none.
  const etaText = formatCalendarDate(po.expected_at);
  // No destination: the purchase order cannot be received here yet.
  const receivable = Boolean(po.destination_warehouse_id);

  return (
    <Pressable
      onPress={onPress}
      disabled={!receivable}
      accessibilityRole="button"
      accessibilityState={{ disabled: !receivable }}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16}>
        {/* The card's details fade while it cannot be opened, as before; the
            sentence that says why stays at full strength below them. */}
        <View style={{ opacity: receivable ? 1 : 0.55 }}>
          <View style={poStyles.headerRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Mono size={9.5} tracking={0.2} upper color={c.ink3}>
                — {po.supplier_name ?? 'No supplier'}
              </Mono>
              <Mono size={17} tracking={0.01} color={c.ink} style={{ marginTop: 6 }}>
                {po.po_number}
              </Mono>
            </View>
            {meta.status === 'default' ? (
              <Pill>{meta.label}</Pill>
            ) : (
              <Pill status={meta.status}>{meta.label}</Pill>
            )}
          </View>

          <View style={poStyles.statRow}>
            <SmallStat label="TOTAL" value={`$${po.total.toFixed(0)}`} />
            <SmallStat label="ETA" value={etaText} mono />
          </View>

          {/* The words alone: the bar that stood above them was fixed at 47%
              whatever had been received (D27), and the list reads no line
              quantities to draw a real one. */}
          {isPartial ? (
            <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 12 }}>
              partial receipt in progress
            </Mono>
          ) : null}
        </View>

        {!receivable ? (
          <Mono size={11} color={c.warnText} style={{ marginTop: 8 }}>
            Set destination on web before receiving
          </Mono>
        ) : null}
      </Card>
    </Pressable>
  );
}

function SmallStat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={{ minWidth: 0 }}>
      <Mono size={9.5} tracking={0.18} upper color={c.ink3}>
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
  // The chips' 44pt frames (IconChip minTap) are 3pt wider than the 38pt chip
  // on every side, so the bar takes 3pt off its padding (12, 8) and what sits
  // under it 3pt off its top: the chips and the title sit where they did (gap between chips 8 -> 2).
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 9,
    paddingBottom: 4,
  },
  aiCard: {
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
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
    gap: 12,
  },
  reloadNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 10,
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
