import { formatOrderNumber } from '@stockpilot/core';
import { type Href, useRouter } from 'expo-router';
import { ShoppingCart } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { profileFromEmbed, resolveRequesterLabel } from '@/lib/requester-label';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { MobileTour } from '@/components/onboarding/mobile-tour';
import { useTourTarget } from '@/lib/tour-targets';
import { MOBILE_ORDERS_TOUR } from '@/lib/onboarding';

interface OrderRow {
  id: string;
  order_number: number | null;
  status: string;
  requester: string;
  requester_org_label: string | null;
  approved_at: string | null;
  delivered_at: string | null;
  created_at: string;
  warehouse: { name: string | null } | null;
  lineCount: number;
}

const STATUS_META: Record<string, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  pending_approval: { label: 'PENDING', status: 'warn' },
  approved: { label: 'APPROVED', status: 'ok' },
  packaging: { label: 'PACKING', status: 'default' },
  ready_for_delivery: { label: 'READY', status: 'ok' },
  delivered: { label: 'DELIVERED', status: 'ok' },
  denied: { label: 'DENIED', status: 'crit' },
  cancelled: { label: 'CANCELLED', status: 'crit' },
};

/**
 * Orders list screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/orders.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/orders-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 */
export default function OrdersScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<OrderRow[]>([]);
  const firstRowTargetRef = useTourTarget('orders-first-row');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('order_requests')
      .select(
        // `requester:user_profiles!requester_user_id` resolves the team-member
        // name that internal orders DON'T denormalize onto the row (else they
        // showed "Unknown requester"). RLS lets org members read each other.
        `id, order_number, status, requester_name, requester_email, requester_user_id, requester_org_label,
         approved_at, delivered_at, created_at,
         warehouse:warehouses!warehouse_id (name),
         requester:user_profiles!requester_user_id (full_name, email),
         lines:order_request_lines (id)`,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
        const whObj = Array.isArray(wh) ? wh[0] : wh;
        const lines = (r.lines as unknown[] | null) ?? [];
        return {
          id: r.id as string,
          order_number: (r.order_number as number | null) ?? null,
          status: r.status as string,
          requester: resolveRequesterLabel({
            requesterName: (r.requester_name as string | null) ?? null,
            requesterEmail: (r.requester_email as string | null) ?? null,
            requesterUserId: (r.requester_user_id as string | null) ?? null,
            profile: profileFromEmbed(r.requester),
          }),
          requester_org_label: (r.requester_org_label as string | null) ?? null,
          approved_at: (r.approved_at as string | null) ?? null,
          delivered_at: (r.delivered_at as string | null) ?? null,
          created_at: r.created_at as string,
          warehouse: whObj ?? null,
          lineCount: lines.length,
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

  const pendingCount = rows.filter((r) => r.status === 'pending_approval').length;

  return (
    <DataListScreen
      eyebrow={`ORDERS · ${pendingCount} PENDING`}
      title="Order"
      italic="requests."
      emptyTitle="No orders yet."
      emptyBody="When someone requests inventory from one of your warehouses, the request lands here."
      emptyIcon={ShoppingCart}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(o) => o.id}
      renderItem={(o, i) =>
        i === 0 ? (
          <View ref={firstRowTargetRef} collapsable={false}>
            <OrderCard order={o} />
          </View>
        ) : (
          <OrderCard order={o} />
        )
      }
      trailing={<MobileTour tour={MOBILE_ORDERS_TOUR} />}
    />
  );
}

function OrderCard({ order }: { order: OrderRow }) {
  const { c } = useTheme();
  const router = useRouter();
  const meta = STATUS_META[order.status] ?? { label: order.status.toUpperCase(), status: 'default' as const };
  const requester = order.requester;
  const when = new Date(order.created_at);

  return (
    <Pressable
      onPress={() => router.push(`/order/${order.id}` as Href)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              {order.order_number ? `${formatOrderNumber(order.order_number)} — ` : '— '}{order.warehouse?.name ?? 'No warehouse'}
            </Mono>
            <Body size={15.5} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
              {requester}
            </Body>
            {order.requester_org_label ? (
              <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
                {order.requester_org_label}
              </Mono>
            ) : null}
          </View>
          {meta.status === 'default' ? <Pill>{meta.label}</Pill> : <Pill status={meta.status}>{meta.label}</Pill>}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <Mono size={11} tracking={0.04} color={c.ink4}>
            {order.lineCount} {order.lineCount === 1 ? 'line' : 'lines'}
          </Mono>
          <Mono size={11} tracking={0.04} color={c.ink4}>
            {when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </Mono>
        </View>
      </Card>
    </Pressable>
  );
}
