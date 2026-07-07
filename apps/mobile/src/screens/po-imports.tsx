import { useRouter } from 'expo-router';
import { Upload } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
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
 */
export default function POImportsScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

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
      eyebrow="PROCUREMENT · PO IMPORTS"
      title="Import"
      italic="history."
      emptyTitle="No imports yet."
      emptyBody="Scan a packing slip from the Receive tab — Gemini parses it and the import lands here as a draft PO."
      emptyIcon={Upload}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(i) => i.id}
      renderItem={(i) => <ImportCard row={i} onPress={() => router.push('/scan-po')} />}
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
