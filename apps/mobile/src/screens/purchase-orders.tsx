import { useRouter } from 'expo-router';
import { ClipboardList, ScanLine, Upload, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { can, formatCalendarDate, type Role } from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Mono } from '@/components/ui/text';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { retryWorkspace } from '@/lib/use-workspace';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface PORow {
  id: string;
  po_number: string;
  status: string;
  total: number;
  expected_at: string | null;
  created_at: string;
  supplier: { name: string | null } | null;
}

const STATUS_META: Record<string, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  draft: { label: 'DRAFT', status: 'default' },
  // Receive POs says EXPECTED and the web Expected; without this entry the
  // card printed the raw key, EXPECTED_INBOUND.
  expected_inbound: { label: 'EXPECTED', status: 'default' },
  ordered: { label: 'ORDERED', status: 'default' },
  partially_received: { label: 'PARTIAL', status: 'warn' },
  received: { label: 'RECEIVED', status: 'ok' },
  cancelled: { label: 'CANCELLED', status: 'crit' },
};

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "No POs yet." (redesign defect D25): it keeps the rows this
 * workspace already shows, marked failed so the screen says so above them, or
 * with none it is the failure itself. Another workspace's rows are never kept.
 */
function settleList<Row>(
  prev: ListState<Row> | null,
  orgId: string,
  rows: Row[] | null,
): ListState<Row> {
  if (rows) return { orgId, rows, failed: false };
  return { orgId, rows: prev && prev.orgId === orgId ? prev.rows : [], failed: true };
}

/**
 * Purchase orders screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/purchase-orders.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/purchase-orders-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * A failed read says so (DataListScreen's `failed`), never "No POs yet."; a
 * refresh that fails keeps the list and says so above it; with no workspace a
 * pull loads it again.
 */
export default function PurchaseOrdersScreen() {
  const router = useRouter();
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<PORow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  // Same gate as the Import history screen: managers, or anyone granted
  // purchase_orders:manage. Owner report 2026-07-18: this screen is what the
  // customizable tab bar labels "PO List" — people look for the scan/import
  // entry HERE, not on the (often hidden) PO Imports tab, so both screens
  // carry the same affordances.
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const canManage =
    role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage');

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: PORow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(
          `id, po_number, status, total, expected_at, created_at,
           supplier:suppliers!supplier_id (name)`,
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100);
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);
      rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const sup = r.supplier as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          po_number: r.po_number as string,
          status: r.status as string,
          total: Number(r.total) || 0,
          expected_at: (r.expected_at as string | null) ?? null,
          created_at: r.created_at as string,
          supplier: Array.isArray(sup) ? (sup[0] ?? null) : sup,
        };
      });
    } catch (e) {
      console.warn('[purchase-orders] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only rows read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = React.useMemo(() => list?.rows ?? [], [list]);
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again).
  const noWorkspace = !orgId && !workspaceLoading;
  const failedEmpty = noWorkspace || (list !== null && list.failed && rows.length === 0);

  async function refresh() {
    setRefreshing(true);
    try {
      await (noWorkspace ? retryWorkspace() : load());
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <DataListScreen
      trailing={
        <View style={styles.headerActions}>
          <HeaderAction
            icon={Upload}
            label="Imports"
            onPress={() => router.push('/po-imports' as never)}
          />
          {canManage ? (
            <HeaderAction icon={ScanLine} label="Scan PO" onPress={() => router.push('/scan-po')} />
          ) : null}
        </View>
      }
      eyebrow={
        list === null || failedEmpty ? 'PROCUREMENT · POs' : `PROCUREMENT · ${rows.length} POs`
      }
      title="Purchase"
      italic="orders."
      emptyTitle="No POs yet."
      emptyBody="Create purchase orders on the web; the open ones show on the POs tab for receiving."
      emptyIcon={ClipboardList}
      failed={
        noWorkspace
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
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(p) => p.id}
      renderItem={(p) => (
        <POCard
          po={p}
          onPress={() => router.push({ pathname: '/po/[id]', params: { id: p.id } } as never)}
        />
      )}
    />
  );
}

/**
 * A header pill: the outlined control (the stronger border on the card fill)
 * inside a frame at least 44pt tall, so the target a finger and VoiceOver get
 * is a real frame rather than a slop around a 30pt pill.
 */
function HeaderAction({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.headerActionFrame, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.headerAction, { borderColor: c.hair2, backgroundColor: c.card }]}>
        <Icon size={14} color={c.ink} strokeWidth={1.6} />
        <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
          {label}
        </Mono>
      </View>
    </Pressable>
  );
}

function POCard({ po, onPress }: { po: PORow; onPress: () => void }) {
  const { c } = useTheme();
  const meta = STATUS_META[po.status] ?? {
    label: po.status.toUpperCase(),
    status: 'default' as const,
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16}>
        <View style={styles.cardHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink3}>
              — {po.supplier?.name ?? 'No supplier'}
            </Mono>
            <Mono size={16} tracking={0.01} color={c.ink} style={{ marginTop: 6 }}>
              {po.po_number}
            </Mono>
          </View>
          {meta.status === 'default' ? (
            <Pill>{meta.label}</Pill>
          ) : (
            <Pill status={meta.status}>{meta.label}</Pill>
          )}
        </View>
        <View style={styles.cardFoot}>
          <Mono size={13} color={c.ink} style={{ fontFamily: FONT.display }}>
            ${po.total.toFixed(0)}
          </Mono>
          <Mono size={11} tracking={0.04} color={c.ink3}>
            {/* The expected date is a DAY stored as its UTC midnight, so it is
                read in UTC (in the phone's zone it was the day before in every
                US zone); created_at is an instant. */}
            {po.expected_at
              ? `ETA ${formatCalendarDate(po.expected_at)}`
              : `created ${new Date(po.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          </Mono>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', gap: 8 },
  headerActionFrame: { minHeight: 44, justifyContent: 'center' },
  headerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
  },
  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 12,
  },
});
