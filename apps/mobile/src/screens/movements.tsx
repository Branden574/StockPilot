import { useRouter } from 'expo-router';
import { ArrowLeftRight, Minus, Plus, RotateCcw } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
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

/**
 * Stock movements ledger screen. Lives in src/screens so two thin routes can
 * render the same component: the drawer destination
 * app/(drawer)/movements.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/movements-tab.tsx (Settings → Customize tab bar).
 * DataListScreen pads for the tab bar only when rendered inside the tabs
 * navigator, so the drawer rendering is unchanged.
 */
export default function MovementsScreen() {
  const { orgId } = useOrg();
  const router = useRouter();
  const [rows, setRows] = React.useState<MovementRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('stock_movements')
      .select(
        `id, movement_type, quantity_change, previous_quantity, new_quantity,
         reason, created_at, item_id,
         item:inventory_items!item_id (name, sku),
         actor:user_profiles!user_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const item = r.item as MovementRow['item'] | MovementRow['item'][] | null;
        const actor = r.actor as MovementRow['actor'] | MovementRow['actor'][] | null;
        return {
          id: r.id as string,
          movement_type: r.movement_type as string,
          quantity_change: Number(r.quantity_change) || 0,
          previous_quantity: Number(r.previous_quantity) || 0,
          new_quantity: Number(r.new_quantity) || 0,
          reason: (r.reason as string | null) ?? null,
          created_at: r.created_at as string,
          item_id: r.item_id as string,
          item: Array.isArray(item) ? item[0] ?? null : item,
          actor: Array.isArray(actor) ? actor[0] ?? null : actor,
        };
      }),
    );
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
      eyebrow={`ACTIVITY · ${rows.length} EVENTS`}
      title="Stock"
      italic="movements."
      emptyTitle="No movements yet."
      emptyBody="Every receive, adjust, transfer, and count posts a row to the ledger here."
      emptyIcon={ArrowLeftRight}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(m) => m.id}
      renderItem={(m) => <MovementCard m={m} onPress={() => router.push({ pathname: '/item/[id]', params: { id: m.item_id } })} />}
    />
  );
}

function MovementCard({ m, onPress }: { m: MovementRow; onPress: () => void }) {
  const { c } = useTheme();
  const isAdd = m.quantity_change > 0;
  const Icon = isAdd ? Plus : m.quantity_change < 0 ? Minus : RotateCcw;
  const pipColor = isAdd ? ACCENT.mint : m.quantity_change < 0 ? ACCENT.crit : ACCENT.warn;
  const verb = TYPE_LABEL[m.movement_type] ?? m.movement_type;
  const actor = m.actor?.full_name ?? m.actor?.email ?? 'system';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
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
              backgroundColor: c.card,
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
            <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
              {verb}
              {m.reason ? ` · ${m.reason}` : ''}
              {' · '}
              {actor}
            </Mono>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Mono
              size={16}
              tracking={-0.012}
              color={isAdd ? ACCENT.mintInk : m.quantity_change < 0 ? ACCENT.crit : c.ink}
              style={{ fontFamily: FONT.display }}
            >
              {isAdd ? '+' : ''}
              {m.quantity_change}
            </Mono>
            <Mono size={10} color={c.ink4} tracking={0.04} style={{ marginTop: 2 }}>
              {new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Mono>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}
