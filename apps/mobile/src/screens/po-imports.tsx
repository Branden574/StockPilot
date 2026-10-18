import { can, poImportUploaderLabel, type Role } from '@stockpilot/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScanLine, Upload } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { readPoImportUploaders } from '@/lib/po-import-uploaders';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { retryWorkspace } from '@/lib/use-workspace';
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
  /** Who uploaded it: name, else email, "Former member", or "—" when the
   *  lookup failed (poImportUploaderLabel). Never an id. */
  uploader: string;
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

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "No imports yet." (redesign defect D25): it keeps the imports
 * this workspace already shows, marked failed so the screen says so above
 * them, or with none it is the failure itself. Another workspace's imports
 * are never kept.
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
 * PO imports screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/po-imports.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/po-imports-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * Header carries the Scan/Import entry (→ /scan-po) so imports can start
 * HERE, not only from the Receive tab; a card opens the native review screen
 * at /po-import/[id] (parse-retry / cancel / full approve flow).
 *
 * A failed read is said in DataListScreen's `failed` panel with its own words,
 * never by swapping them into the empty state (D25); a refresh that fails
 * keeps the imports and says so above them; with no workspace a pull loads it
 * again.
 */
export default function POImportsScreen() {
  const router = useRouter();
  const { orgId, loading: workspaceLoading } = useOrg();
  const { c } = useTheme();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const [stored, setStored] = React.useState<ListState<ImportRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a focus, a pull, or a workspace switch).
  const seqRef = React.useRef(0);

  // Scan entry gate — same 'purchase_orders:manage' the drawer link, the web
  // imports surface, and every /api/v1/po-imports route assert. Cosmetic only;
  // the scan + write APIs re-check server-side.
  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canManage =
    isManager ||
    (role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage'));

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: ImportRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('po_imports')
        .select(
          `id, source_type, file_name, file_size, status, parse_error,
           approved_po_id, created_at, uploaded_by, deleted_users,
           vendor:suppliers!vendor_id (name)`,
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100);
      // An ignored error here read as an empty history ("No imports yet.") for
      // an org that has imports: the failure is said instead. Only the
      // message travels on (and into the warning below), never the whole
      // PostgREST error object.
      if (error) throw new Error(error.message);
      const raw = (data ?? []) as Record<string, unknown>[];
      // Who uploaded each import (web parity). Batched; a failed lookup is
      // warned about and labels "—", and the list still shows.
      const uploaders = await readPoImportUploaders(
        supabase,
        raw.map((r) => (r.uploaded_by as string | null) ?? null),
      );
      rows = raw.map((r) => {
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
          vendor: Array.isArray(vendor) ? (vendor[0] ?? null) : vendor,
          // The import's stamp reads "Deleted user" (0393).
          uploader: poImportUploaderLabel(
            uploaders,
            (r.uploaded_by as string | null) ?? null,
            r.deleted_users,
          ),
        };
      });
    } catch (e) {
      console.warn('[po-imports] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  // Reload on FOCUS (not just mount) so returning from the detail screen —
  // after an approve, cancel, or re-parse — shows the new status immediately.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  // Only imports read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = React.useMemo(() => list?.rows ?? [], [list]);
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again).
  const noWorkspace = !orgId && !workspaceLoading;

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
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load imports.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the imports. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(i) => i.id}
      renderItem={(i) => (
        <ImportCard
          row={i}
          onPress={() => router.push({ pathname: '/po-import/[id]', params: { id: i.id } })}
        />
      )}
      trailing={
        canManage ? (
          // The outlined pill inside a frame at least 44pt tall: the target a
          // finger and VoiceOver get is a real frame, not a slop.
          <Pressable
            onPress={() => router.push('/scan-po')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.headerActionFrame, { opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.headerAction, { borderColor: c.hair2, backgroundColor: c.card }]}>
              <ScanLine size={14} color={c.ink} strokeWidth={1.6} />
              <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
                Scan PO
              </Mono>
            </View>
          </Pressable>
        ) : undefined
      }
    />
  );
}

function ImportCard({ row, onPress }: { row: ImportRow; onPress: () => void }) {
  const { c } = useTheme();
  const meta = STATUS_META[row.status] ?? {
    label: row.status.toUpperCase(),
    status: 'default' as const,
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={styles.cardHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink3}>
              — {row.source_type}
            </Mono>
            <Body size={14} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
              {row.file_name}
            </Body>
            <Mono size={11} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}>
              {row.vendor?.name ? `${row.vendor.name} · ` : ''}
              {new Date(row.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
              {` · by ${row.uploader}`}
            </Mono>
            {row.parse_error ? (
              <Body muted size={12} style={{ marginTop: 6 }}>
                {row.parse_error}
              </Body>
            ) : null}
          </View>
          {meta.status === 'default' ? (
            <Pill>{meta.label}</Pill>
          ) : (
            <Pill status={meta.status}>{meta.label}</Pill>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
});
