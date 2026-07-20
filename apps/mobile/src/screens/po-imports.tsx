import { can, type Role } from '@stockpilot/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScanLine, Upload } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface ImportRow {
  id: string;
  source_type: string;
  file_name: string;
  file_size: number;
  status: string;
  parse_error: string | null;
  approved_po_id: string | null;
  created_at: string;
  vendor: { name: string | null } | null;
}

const STATUS_META: Record<string, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  uploaded: { label: 'UPLOADED', status: 'default' },
  parsing: { label: 'PARSING', status: 'warn' },
  parsed: { label: 'PARSED', status: 'ok' },
  needs_review: { label: 'REVIEW', status: 'warn' },
  approved: { label: 'APPROVED', status: 'ok' },
  failed: { label: 'FAILED', status: 'crit' },
  duplicate: { label: 'DUPLICATE', status: 'crit' },
  canceled: { label: 'CANCELLED', status: 'default' },
};

/**
 * PO imports screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/po-imports.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/po-imports-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 *
 * Header carries the Scan/Import entry (→ /scan-po) so imports can start
 * HERE, not only from the Receive tab; a card opens the native review screen
 * at /po-import/[id] (parse-retry / cancel / full approve flow).
 */
export default function POImportsScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  // Scan entry gate — same 'purchase_orders:manage' the drawer link, the web
  // imports surface, and every /api/v1/po-imports route assert. Cosmetic only;
  // the scan + write APIs re-check server-side.
  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canManage =
    isManager ||
    (role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage'));

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('po_imports')
      .select(
        `id, source_type, file_name, file_size, status, parse_error,
         approved_po_id, created_at,
         vendor:suppliers!vendor_id (name)`,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const vendor = r.vendor as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          source_type: r.source_type as string,
          file_name: r.file_name as string,
          file_size: Number(r.file_size) || 0,
          status: r.status as string,
          parse_error: (r.parse_error as string | null) ?? null,
          approved_po_id: (r.approved_po_id as string | null) ?? null,
          created_at: r.created_at as string,
          vendor: Array.isArray(vendor) ? vendor[0] ?? null : vendor,
        };
      }),
    );
    setLoading(false);
  }, [orgId]);

  // Reload on FOCUS (not just mount) so returning from the detail screen —
  // after an approve, cancel, or re-parse — shows the new status immediately.
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

  return (
    <DataListScreen
      eyebrow="PROCUREMENT · PO IMPORTS"
      title="Import"
      italic="history."
      emptyTitle="No imports yet."
      emptyBody={
        canManage
          ? 'Scan a packing slip or PO with the Scan button above — the parsed import lands here for review and approval.'
          : 'Scanned POs land here once someone with purchase-order access imports one.'
      }
      emptyIcon={Upload}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(i) => i.id}
      renderItem={(i) => (
        <ImportCard
          row={i}
          onPress={() => router.push({ pathname: '/po-import/[id]', params: { id: i.id } })}
        />
      )}
      trailing={
        canManage ? (
          <Pressable
            onPress={() => router.push('/scan-po')}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderWidth: 1,
              borderRadius: 999,
              borderColor: c.hair,
              backgroundColor: c.card,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <ScanLine size={14} color={c.ink} strokeWidth={1.6} />
            <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
              Scan PO
            </Mono>
          </Pressable>
        ) : undefined
      }
    />
  );
}

function ImportCard({ row, onPress }: { row: ImportRow; onPress: () => void }) {
  const { c } = useTheme();
  const meta = STATUS_META[row.status] ?? { label: row.status.toUpperCase(), status: 'default' as const };
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              — {row.source_type}
            </Mono>
            <Body size={14} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
              {row.file_name}
            </Body>
            <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {row.vendor?.name ? `${row.vendor.name} · ` : ''}
              {new Date(row.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Mono>
            {row.parse_error ? (
              <Body muted size={12} style={{ marginTop: 6 }}>
                {row.parse_error}
              </Body>
            ) : null}
          </View>
          {meta.status === 'default' ? <Pill>{meta.label}</Pill> : <Pill status={meta.status}>{meta.label}</Pill>}
        </View>
      </Card>
    </Pressable>
  );
}
