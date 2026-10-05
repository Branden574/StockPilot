import {
  ORDERS_LIST_OPEN_UNCONFIRMED_COPY,
  ORDERS_LIST_RETRY_COPY,
  ORDERS_LIST_UNCONFIRMED_COPY,
  STOREFRONT_TITLE_COPY,
  can,
  formatOrderNumber,
} from '@stockpilot/core';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { Plus, ShoppingCart } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { SmallAction } from '@/components/order-storefront/controls';
import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useEnabledModules } from '@/lib/enabled-modules';
import { unsettledSendsOnDevice } from '@/lib/order-storefront/services';
import { orderStatusPill, ordersListEmpty, ordersListReloadNote, showPlaceOrder } from '@/lib/orders-list';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
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
  const { c } = useTheme();
  const { orgId } = useOrg();
  const { user } = useAuth();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  // Web parity (dashboard/orders/page.tsx): approvers see the whole org queue;
  // everyone else sees only the orders they placed. RLS still returns all rows
  // to any member, so — like web — this is a UX/privacy narrowing, not a hard
  // guarantee. Default to own-only while role/permissions load so a
  // non-approver never briefly sees the full queue (fallback role 'staff' has
  // no orders:approve; widens to all only once an approver's set resolves).
  const canApprove = can({ role: role ?? 'staff', permissions }, 'orders:approve');
  const userId = user?.id ?? null;
  const router = useRouter();
  const enabledModules = useEnabledModules();
  // "+" and the empty state's "Place an order" (phone ordering PO-4): the
  // Orders module on and orders:request (lib/orders-list.ts).
  const canPlace = showPlaceOrder({
    role: role ?? null,
    permissions,
    ordersModuleEnabled: enabledModules.has('orders'),
  });
  const [rows, setRows] = React.useState<OrderRow[]>([]);
  const firstRowTargetRef = useTourTarget('orders-first-row');
  const placeTargetRef = useTourTarget('orders-place-order');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // The read FAILED (D4): said, with a way to load again, never "No orders yet."
  const [failed, setFailed] = React.useState(false);
  // Order requests sent from this phone and not confirmed yet.
  const [unconfirmed, setUnconfirmed] = React.useState(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    // Non-approvers must have a user id to scope to their own requests; without
    // one, show nothing rather than risk the full queue.
    if (!canApprove && !userId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let query = supabase
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
      .eq('organization_id', orgId);
    if (!canApprove) query = query.eq('requester_user_id', userId!);
    const [{ data, error }, unsettled] = await Promise.all([
      query.order('created_at', { ascending: false }).limit(100),
      userId ? unsettledSendsOnDevice(userId, orgId) : Promise.resolve(0),
    ]);
    setUnconfirmed(unsettled);
    if (error) {
      // Keep what was shown before; say the read failed when there is none.
      setFailed(true);
      setLoading(false);
      return;
    }
    setFailed(false);
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
  }, [orgId, canApprove, userId]);

  // Read on every focus, not only on mount (D5): an order just placed, or
  // changed on another screen, shows when the person comes back.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const pendingCount = rows.filter((r) => r.status === 'pending_approval').length;
  const empty = ordersListEmpty(failed && rows.length === 0, canApprove);
  const reloadNote = ordersListReloadNote(failed, rows.length);
  const placeAnOrder = () => router.push('/order/new' as Href);

  return (
    <DataListScreen
      eyebrow={`ORDERS · ${pendingCount} PENDING`}
      title="Order"
      italic="requests."
      emptyTitle={empty.title}
      emptyBody={empty.body}
      emptyAction={
        failed && rows.length === 0 ? (
          <SmallAction label={ORDERS_LIST_RETRY_COPY} onPress={() => void refresh()} />
        ) : canPlace ? (
          <SmallAction label={STOREFRONT_TITLE_COPY} variant="primary" onPress={placeAnOrder} />
        ) : undefined
      }
      header={
        unconfirmed > 0 || reloadNote ? (
          <View style={{ gap: 10 }}>
            {/* A read again that failed keeps the rows shown and says so
                (PO-4 review). */}
            {reloadNote ? (
              <Body size={13} color={c.warnText} accessibilityRole="alert">
                {reloadNote}
              </Body>
            ) : null}
            {unconfirmed > 0 ? (
              <Card padding={12}>
                <View style={{ gap: 8 }}>
                  <Body size={13.5} accessibilityRole="alert">
                    {ORDERS_LIST_UNCONFIRMED_COPY}
                  </Body>
                  <SmallAction label={ORDERS_LIST_OPEN_UNCONFIRMED_COPY} onPress={placeAnOrder} />
                </View>
              </Card>
            ) : null}
          </View>
        ) : undefined
      }
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
      trailing={
        // One trailing slot, shared by the tour and "+" (as Rentals does).
        // marginRight -3: the chip's 44 pt frame is 3 pt wider each side.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <MobileTour tour={MOBILE_ORDERS_TOUR} />
          {canPlace ? (
            <View ref={placeTargetRef} collapsable={false} style={{ marginRight: -3 }}>
              <IconChip icon={Plus} onPress={placeAnOrder} accessibilityLabel={STOREFRONT_TITLE_COPY} minTap />
            </View>
          ) : null}
        </View>
      }
    />
  );
}

function OrderCard({ order }: { order: OrderRow }) {
  const { c } = useTheme();
  const router = useRouter();
  const meta = orderStatusPill(order.status);
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
