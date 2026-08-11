import { RefreshCw } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Toggle } from '@/components/ui/toggle';
import { Body, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
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

/**
 * Recurring PO templates — mobile twin of /dashboard/purchase-orders/recurring.
 * Lists the org's templates with pause/resume + delete. Reads/writes go direct
 * to Supabase: RLS is member read / manager+ write, the same floor the web
 * service enforces, and the daily cron re-checks the org's plan tier before
 * generating POs — so nothing here can unlock what the plan forbids.
 * Template CREATION stays on web (line-item picker is desktop work); the drawer
 * entry is gated to purchase_orders:manage like the web sidebar link.
 */
export default function RecurringPosScreen() {
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const [rows, setRows] = React.useState<TemplateRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!user || !activeOrgId) return;
    const { data } = await supabase
      .from('recurring_po_templates')
      .select(
        'id, name, enabled, cadence, custom_days, send_mode, next_run_at, last_run_at, line_items, supplier:suppliers(name)',
      )
      .eq('organization_id', activeOrgId)
      .order('created_at', { ascending: false })
      .limit(200);
    setRows((data ?? []) as TemplateRow[]);
    setLoading(false);
  }, [user, activeOrgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function toggleEnabled(row: TemplateRow, next: boolean) {
    setBusyId(row.id);
    // Await the builder — a voided supabase builder never sends the request.
    // Optimistic state only after the write lands (recurring-bug pattern #22).
    const { error, data } = await supabase
      .from('recurring_po_templates')
      .update({ enabled: next })
      .eq('id', row.id)
      .eq('organization_id', activeOrgId ?? '')
      .select('id')
      .maybeSingle();
    setBusyId(null);
    if (error || !data) {
      Alert.alert(
        'Could not update',
        error?.message ?? 'You need manager access to change recurring POs.',
      );
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: next } : r)));
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
              const { error, data } = await supabase
                .from('recurring_po_templates')
                .delete()
                .eq('id', row.id)
                .eq('organization_id', activeOrgId ?? '')
                .select('id')
                .maybeSingle();
              setBusyId(null);
              if (error || !data) {
                Alert.alert(
                  'Could not delete',
                  error?.message ?? 'You need manager access to change recurring POs.',
                );
                return;
              }
              setRows((prev) => prev.filter((r) => r.id !== row.id));
            })();
          },
        },
      ],
    );
  }

  return (
    <DataListScreen
      eyebrow={`AUTOMATION · ${rows.filter((r) => r.enabled).length} ACTIVE`}
      title="Recurring POs"
      italic="."
      emptyTitle="No recurring POs yet."
      emptyBody="Create one on the web dashboard from any purchase order (“Make recurring”) — it will generate POs on schedule and show up here."
      emptyIcon={RefreshCw}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} numberOfLines={1}>
            {row.name}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
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
        <Toggle value={row.enabled} onValueChange={busy ? undefined : onToggle} />
      </View>
      <Pressable
        onPress={onDelete}
        disabled={busy}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginTop: 10 })}
      >
        <Mono size={10.5} tracking={0.04} color="#b91c1c">
          Delete template
        </Mono>
      </Pressable>
    </Card>
  );
}
