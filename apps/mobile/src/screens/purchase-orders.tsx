import { useRouter } from 'expo-router';
import { ClipboardList, ScanLine, Upload } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { can, type Role } from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Mono } from '@/components/ui/text';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
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
  ordered: { label: 'ORDERED', status: 'default' },
  partially_received: { label: 'PARTIAL', status: 'warn' },
  received: { label: 'RECEIVED', status: 'ok' },
  cancelled: { label: 'CANCELLED', status: 'crit' },
};

/**
 * Purchase orders screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/purchase-orders.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/purchase-orders-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function PurchaseOrdersScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const [rows, setRows] = React.useState<PORow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

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
    const { data } = await supabase
      .from('purchase_orders')
      .select(
        `id, po_number, status, total, expected_at, created_at,
         supplier:suppliers!supplier_id (name)`,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const sup = r.supplier as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          po_number: r.po_number as string,
          status: r.status as string,
          total: Number(r.total) || 0,
          expected_at: (r.expected_at as string | null) ?? null,
          created_at: r.created_at as string,
          supplier: Array.isArray(sup) ? sup[0] ?? null : sup,
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

  const headerBtn = ({ pressed }: { pressed: boolean }) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
    borderColor: c.hair,
    backgroundColor: c.card,
    opacity: pressed ? 0.7 : 1,
  });

  return (
    <DataListScreen
      trailing={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={() => router.push('/po-imports' as never)} hitSlop={8} style={headerBtn}>
            <Upload size={14} color={c.ink} strokeWidth={1.6} />
            <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
              Imports
            </Mono>
          </Pressable>
          {canManage ? (
            <Pressable onPress={() => router.push('/scan-po')} hitSlop={8} style={headerBtn}>
              <ScanLine size={14} color={c.ink} strokeWidth={1.6} />
              <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
                Scan PO
              </Mono>
            </Pressable>
          ) : null}
        </View>
      }
      eyebrow={`PROCUREMENT · ${rows.length} POs`}
      title="Purchase"
      italic="orders."
      emptyTitle="No POs yet."
      emptyBody="Create purchase orders on the web; the open ones show on the POs tab for receiving."
      emptyIcon={ClipboardList}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
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

function POCard({ po, onPress }: { po: PORow; onPress: () => void }) {
  const { c } = useTheme();
  const meta = STATUS_META[po.status] ?? { label: po.status.toUpperCase(), status: 'default' as const };
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={16}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              — {po.supplier?.name ?? 'No supplier'}
            </Mono>
            <Mono size={16} tracking={0.01} color={c.ink} style={{ marginTop: 6 }}>
              {po.po_number}
            </Mono>
          </View>
          {meta.status === 'default' ? <Pill>{meta.label}</Pill> : <Pill status={meta.status}>{meta.label}</Pill>}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <Mono size={13} color={c.ink} style={{ fontFamily: FONT.display }}>
            ${po.total.toFixed(0)}
          </Mono>
          <Mono size={11} tracking={0.04} color={c.ink4}>
            {po.expected_at
              ? `ETA ${new Date(po.expected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              : `created ${new Date(po.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          </Mono>
        </View>
      </Card>
    </Pressable>
  );
}
