import {
  collectLegacyRefIdsByKind,
  orderNumberLabels,
  resolveMovementRefReason,
  returnNumberLabels,
} from '@stockpilot/core';
import { useRouter } from 'expo-router';
import { ArrowLeftRight, Minus, Plus, RotateCcw } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { actorText, isRowPersonDeleted } from '@/lib/deleted-user-labels';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface MovementRow {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  reason: string | null;
  created_at: string;
  item_id: string;
  item: { name: string; sku: string } | null;
  actor: { full_name: string | null; email: string | null } | null;
  /** The actor deleted their account (0393: user_id null and stamped). */
  actor_deleted: boolean;
}

const TYPE_LABEL: Record<string, string> = {
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

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "No movements yet." (redesign defect D25): it keeps the rows
 * this workspace already shows, marked failed so the screen says so above
 * them, or with none it is the failure itself. Another workspace's rows are
 * never kept.
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
 * Stock movements ledger screen. Lives in src/screens so two thin routes can
 * render the same component: the drawer destination
 * app/(drawer)/movements.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/movements-tab.tsx (Settings → Customize tab bar).
 * DataListScreen pads for the tab bar only when rendered inside the tabs
 * navigator, so the drawer rendering is unchanged.
 *
 * The latest 100 movements, newest first, each opening its item; no filters
 * on the phone. A failed read says so (DataListScreen's `failed`), never "No
 * movements yet."; a refresh that fails keeps the list and says so above it;
 * with no workspace a pull loads it again, as the Locations list does.
 */
export default function MovementsScreen() {
  const { orgId, loading: workspaceLoading } = useOrg();
  const router = useRouter();
  const [stored, setStored] = React.useState<ListState<MovementRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: MovementRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('stock_movements')
        .select(
          `id, movement_type, quantity_change, previous_quantity, new_quantity,
           reason, created_at, item_id, user_id, deleted_users,
           item:inventory_items!item_id (name, sku),
           actor:user_profiles!user_id (full_name, email)`,
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100);
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);

      // Web parity (packages/core movement-order-ref.ts): pick/cancel rows
      // written before migration 0306 stringified the ORDER'S UUID into their
      // reason because order_number only arrived in 0254, and the shipped RMA
      // RPCs (0153/0154/0197) still write a return's uuid the same way. The
      // ledger is append-only, so both are resolved at read time — ONE batched,
      // org-scoped lookup per kind for the whole page, never one per row, and
      // the two run concurrently. A failed/empty lookup degrades to "Order pick"
      // with the parenthetical dropped; the raw uuid never reaches the card.
      const legacyRefIds = collectLegacyRefIdsByKind(
        (data ?? []).map((row) => ({
          reason: (row as Record<string, unknown>).reason as string | null,
        })),
      );
      const [orders, returns] = await Promise.all([
        legacyRefIds.order_request.length > 0
          ? supabase
              .from('order_requests')
              .select('id, order_number')
              .eq('organization_id', orgId)
              // in-list-bound: legacy refs from the 100 movements this screen reads (.limit(100))
              .in('id', legacyRefIds.order_request)
          : Promise.resolve({ data: [] as { id: string; order_number: number | null }[] }),
        legacyRefIds.return.length > 0
          ? supabase
              .from('returns')
              .select('id, return_number')
              .eq('organization_id', orgId)
              // in-list-bound: legacy refs from the 100 movements this screen reads (.limit(100))
              .in('id', legacyRefIds.return)
          : Promise.resolve({ data: [] as { id: string; return_number: string | null }[] }),
      ]);
      const refLabelById = new Map([
        ...orderNumberLabels((orders.data ?? []) as { id: string; order_number: number | null }[]),
        ...returnNumberLabels(
          (returns.data ?? []) as { id: string; return_number: string | null }[],
        ),
      ]);

      rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const item = r.item as MovementRow['item'] | MovementRow['item'][] | null;
        const actor = r.actor as MovementRow['actor'] | MovementRow['actor'][] | null;
        return {
          id: r.id as string,
          movement_type: r.movement_type as string,
          quantity_change: Number(r.quantity_change) || 0,
          previous_quantity: Number(r.previous_quantity) || 0,
          new_quantity: Number(r.new_quantity) || 0,
          reason: resolveMovementRefReason((r.reason as string | null) ?? null, refLabelById),
          created_at: r.created_at as string,
          item_id: r.item_id as string,
          item: Array.isArray(item) ? (item[0] ?? null) : item,
          actor: Array.isArray(actor) ? (actor[0] ?? null) : actor,
          actor_deleted: isRowPersonDeleted(r),
        };
      });
    } catch (e) {
      console.warn('[movements] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only rows read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = list?.rows ?? [];
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
      eyebrow={
        list === null || failedEmpty ? 'ACTIVITY · EVENTS' : `ACTIVITY · ${rows.length} EVENTS`
      }
      title="Stock"
      italic="movements."
      emptyTitle="No movements yet."
      emptyBody="Every receive, adjust, transfer, and count posts a row to the ledger here."
      emptyIcon={ArrowLeftRight}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load movements.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the movements. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(m) => m.id}
      renderItem={(m) => (
        <MovementCard
          m={m}
          onPress={() => router.push({ pathname: '/item/[id]', params: { id: m.item_id } })}
        />
      )}
    />
  );
}

/**
 * One ledger row: what moved (the item), how (the verb, the resolved reason,
 * who), the signed change and the day. The sign is in the words ("+3", "-2")
 * and the glyph (+, -, rotate); the colours repeat it: accent for stock in,
 * the refusal red for stock out, the warning tone for a change of 0.
 */
function MovementCard({ m, onPress }: { m: MovementRow; onPress: () => void }) {
  const { c } = useTheme();
  const isAdd = m.quantity_change > 0;
  const Icon = isAdd ? Plus : m.quantity_change < 0 ? Minus : RotateCcw;
  const pipColor = isAdd ? c.accent : m.quantity_change < 0 ? c.critText : c.warnText;
  const verb = TYPE_LABEL[m.movement_type] ?? m.movement_type;
  const actor = actorText(m.actor, m.actor_deleted);
  return (
    <Pressable
      onPress={onPress}
      // A button to VoiceOver (it read the row's words with no trait).
      accessibilityRole="button"
      accessibilityHint="Opens the item"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: c.hair,
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              backgroundColor: c.sunk,
            }}
          >
            <Icon size={14} color={c.ink} strokeWidth={1.6} />
            <View
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                width: 5,
                height: 5,
                borderRadius: 3,
                backgroundColor: pipColor,
              }}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
              {m.item?.name ?? 'Unknown item'}
            </Body>
            <Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}>
              {verb}
              {m.reason ? ` · ${m.reason}` : ''}
              {' · '}
              {actor}
            </Mono>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Mono
              size={15}
              tracking={0}
              color={isAdd ? c.accent : m.quantity_change < 0 ? c.critText : c.ink}
            >
              {isAdd ? '+' : ''}
              {m.quantity_change}
            </Mono>
            <Mono size={11} color={c.ink3} tracking={0.04} style={{ marginTop: 2 }}>
              {new Date(m.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </Mono>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}
