import { RefreshCw } from 'lucide-react-native';
import * as React from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Toggle } from '@/components/ui/toggle';
import { Body, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { retryWorkspace, useWorkspace } from '@/lib/use-workspace';
import { useTheme } from '@/lib/use-theme';

interface TemplateRow {
  id: string;
  name: string;
  enabled: boolean;
  cadence: string;
  custom_days: number | null;
  send_mode: 'draft' | 'send';
  next_run_at: string | null;
  last_run_at: string | null;
  line_items: unknown[];
  supplier: { name: string | null } | { name: string | null }[] | null;
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  custom: 'Custom',
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
 * read is never "No recurring POs yet." (redesign defect D25): it keeps the
 * templates this workspace already shows, marked failed so the screen says so
 * above them, or with none it is the failure itself. Another workspace's
 * templates are never kept.
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
 * Recurring PO templates — mobile twin of /dashboard/purchase-orders/recurring.
 * Lists the org's templates with pause/resume + delete. The LIST read goes
 * direct to Supabase: RLS is member read, the same floor the web service
 * enforces, and the daily cron re-checks the org's plan tier before generating
 * POs — so nothing here can unlock what the plan forbids.
 * Template CREATION stays on web (line-item picker is desktop work); the drawer
 * entry is gated to purchase_orders:manage like the web sidebar link.
 *
 * WRITES DO NOT (SP-122). Pause/resume and delete used to be direct PostgREST
 * writes too. RLS accepted them (manager+ / purchase_orders:manage — the same
 * floor again), so the gap was never authorization: it was the AUDIT TRAIL.
 * `audit_logs` is written by app code only (web's server/services/audit.ts,
 * through the service-role client) — there is no DB trigger, and the table's
 * only policy is SELECT — so a template paused or deleted from a phone left no
 * trace, while the same action on web left one. This org reads that log ON THE
 * PHONE (app/(drawer)/admin/audit.tsx), so "why did the monthly PO stop?" had
 * an answer on web and a blank here. Both writes now go through
 * PATCH/DELETE /api/v1/recurring-pos/[id] → RecurringPoTemplatesService
 * .setEnabled/remove, which audits with the bearer ctx and stamps updated_by
 * (the direct write never did). Same rule as the Staging screen: a mobile
 * write goes through the shared service, never a second query.
 *
 * A failed read says so (DataListScreen's `failed`), never "No recurring POs
 * yet."; a refresh that fails keeps the list and says so above it; with no
 * workspace a pull loads it again.
 */
export default function RecurringPosScreen() {
  const { user } = useAuth();
  const { activeOrgId, loading: workspaceLoading } = useWorkspace();
  const [stored, setStored] = React.useState<ListState<TemplateRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  // The templates on screen, changed in place after a write the server took
  // (the toggle and delete paths below).
  const setRows = React.useCallback(
    (update: (prev: TemplateRow[]) => TemplateRow[]) =>
      setStored((prev) => (prev ? { ...prev, rows: update(prev.rows) } : prev)),
    [],
  );

  const load = React.useCallback(async () => {
    if (!user || !activeOrgId) return;
    const seq = ++seqRef.current;
    let rows: TemplateRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('recurring_po_templates')
        .select(
          'id, name, enabled, cadence, custom_days, send_mode, next_run_at, last_run_at, line_items, supplier:suppliers(name)',
        )
        .eq('organization_id', activeOrgId)
        .order('created_at', { ascending: false })
        .limit(200);
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);
      rows = (data ?? []) as TemplateRow[];
    } catch (e) {
      console.warn('[recurring-pos] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, activeOrgId, rows));
  }, [user, activeOrgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only templates read for the workspace on screen.
  const list = stored && stored.orgId === activeOrgId ? stored : null;
  const rows = React.useMemo(() => list?.rows ?? [], [list]);
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again).
  const noWorkspace = !activeOrgId && !workspaceLoading;
  const failedEmpty = noWorkspace || (list !== null && list.failed && rows.length === 0);

  async function refresh() {
    setRefreshing(true);
    try {
      await (noWorkspace ? retryWorkspace() : load());
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleEnabled(row: TemplateRow, next: boolean) {
    setBusyId(row.id);
    try {
      // The route (not PostgREST) is what reaches the audited service; api()
      // throws on any non-2xx, so the write is still fail-CLOSED and the
      // permission/plan refusals arrive as a sentence we can show.
      await api(`/api/v1/recurring-pos/${row.id}`, {
        method: 'PATCH',
        body: { enabled: next },
      });
      // Optimistic state only after the write lands (recurring-bug pattern #22):
      // a list updated next to a refused write hides the failure completely.
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: next } : r)));
    } catch (e) {
      Alert.alert(
        'Could not update',
        e instanceof Error ? e.message : 'You need manager access to change recurring POs.',
      );
    } finally {
      setBusyId(null);
    }
  }

  function confirmDelete(row: TemplateRow) {
    Alert.alert(
      'Delete recurring PO?',
      `"${row.name}" will stop generating purchase orders. Already-created POs are not affected.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(row.id);
              try {
                // Same reason as the toggle: the service behind this route is
                // the only writer of the 'recurring_po_template.deleted' event.
                await api(`/api/v1/recurring-pos/${row.id}`, { method: 'DELETE' });
                setRows((prev) => prev.filter((r) => r.id !== row.id));
              } catch (e) {
                Alert.alert(
                  'Could not delete',
                  e instanceof Error
                    ? e.message
                    : 'You need manager access to change recurring POs.',
                );
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ],
    );
  }

  return (
    <DataListScreen
      eyebrow={
        list === null || failedEmpty
          ? 'AUTOMATION'
          : `AUTOMATION · ${rows.filter((r) => r.enabled).length} ACTIVE`
      }
      title="Recurring POs"
      italic="."
      emptyTitle="No recurring POs yet."
      emptyBody="Create one on the web dashboard from any purchase order (“Make recurring”) — it will generate POs on schedule and show up here."
      emptyIcon={RefreshCw}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load recurring POs.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the recurring POs. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(t) => t.id}
      renderItem={(t) => (
        <TemplateCard
          row={t}
          busy={busyId === t.id}
          onToggle={(v) => void toggleEnabled(t, v)}
          onDelete={() => confirmDelete(t)}
        />
      )}
    />
  );
}

function TemplateCard({
  row,
  busy,
  onToggle,
  onDelete,
}: {
  row: TemplateRow;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
}) {
  const { c } = useTheme();
  const supplierObj = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier;
  const cadence =
    row.cadence === 'custom' && row.custom_days
      ? `Every ${row.custom_days} days`
      : (CADENCE_LABEL[row.cadence] ?? row.cadence);
  const nextRun = row.next_run_at
    ? new Date(row.next_run_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '—';
  const lineCount = Array.isArray(row.line_items) ? row.line_items.length : 0;
  return (
    <Card padding={14}>
      <View style={styles.row}>
        <View style={styles.body}>
          <Body size={15} color={c.ink} numberOfLines={1}>
            {row.name}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}>
            {[
              supplierObj?.name ?? 'No supplier',
              cadence,
              `${lineCount} line${lineCount === 1 ? '' : 's'}`,
              row.enabled ? `next ${nextRun}` : 'paused',
            ].join(' · ')}
          </Mono>
        </View>
        <Pill status={row.send_mode === 'send' ? 'ok' : 'default'}>
          {row.send_mode === 'send' ? 'Auto-send' : 'Draft'}
        </Pill>
        {/* No visible label sits with the switch, so it carries the
            template's name: VoiceOver said "switch, on" and nothing else. */}
        <Toggle
          value={row.enabled}
          onValueChange={busy ? undefined : onToggle}
          accessibilityLabel={row.name}
        />
      </View>
      {/* Refusal-red words on no fill, in the shared small button's 44pt
          frame (it was the height of its 10.5pt line and a fixed red under
          AA in dark). */}
      <Button
        variant="destructive"
        size="sm"
        onPress={onDelete}
        disabled={busy}
        style={styles.delete}
      >
        Delete template
      </Button>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { flex: 1, minWidth: 0 },
  delete: {
    alignSelf: 'flex-start',
    paddingHorizontal: 0,
    marginTop: 4,
    marginBottom: -8,
  },
});
