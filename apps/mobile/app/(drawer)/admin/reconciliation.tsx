import { BarChart3 } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface ClosedCount {
  id: string;
  posted_at: string;
  notes: string | null;
  warehouse: { name: string | null } | null;
  lineCount: number;
  variances: number;
}

/**
 * Reconciliation = a read-only view over recently-posted cycle counts
 * with their variance counts. The full web surface has filters, exports,
 * and a posting workflow — those land in a later mobile release.
 */
export default function ReconciliationAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<ClosedCount[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('cycle_counts')
      .select(
        `id, posted_at, notes,
         warehouse:warehouses!warehouse_id (name),
         lines:cycle_count_lines (id, expected_quantity, counted_quantity)`,
      )
      .eq('organization_id', orgId)
      .eq('status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(50);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
        const lines = ((r.lines ?? []) as Array<{ expected_quantity: number; counted_quantity: number | null }>);
        const variances = lines.filter(
          (l) => l.counted_quantity != null && Number(l.counted_quantity) !== Number(l.expected_quantity),
        ).length;
        return {
          id: r.id as string,
          posted_at: r.posted_at as string,
          notes: (r.notes as string | null) ?? null,
          warehouse: Array.isArray(wh) ? wh[0] ?? null : wh,
          lineCount: lines.length,
          variances,
        };
      }),
    );
    setLoading(false);
  }, [orgId, isAdmin]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await except the pre-await guard that resolves loading for the unauthorized; the effect synchronizes with the server
    if (!roleLoading) void load();
  }, [load, roleLoading]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!roleLoading && !isAdmin) {
    return (
      <DataListScreen
        eyebrow="ADMIN · RECONCILIATION"
        title="Restricted"
        italic="access."
        emptyIcon={BarChart3}
        emptyTitle="Admin only."
        emptyBody=""
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow={`ADMIN · ${rows.length} POSTED COUNTS`}
      title="Reconciliation"
      italic="."
      emptyTitle="No posted counts yet."
      emptyBody="When a cycle count is posted, the variance report appears here."
      emptyIcon={BarChart3}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <ReconCard count={c} />}
    />
  );
}

function ReconCard({ count }: { count: ClosedCount }) {
  const { c } = useTheme();
  const posted = new Date(count.posted_at);
  function openOnWeb() {
    Linking.openURL(`https://stockpilotusa.com/dashboard/cycle-counts/${count.id}`).catch(() => undefined);
  }
  return (
    <Pressable onPress={openOnWeb} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
              — {count.warehouse?.name ?? 'No warehouse'}
            </Mono>
            <Body size={14.5} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
              Posted {posted.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </Body>
            {count.notes ? (
              <Body muted size={12.5} style={{ marginTop: 4 }} numberOfLines={2}>
                {count.notes}
              </Body>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 10 }}>
              <View>
                <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
                  LINES
                </Mono>
                <Mono size={15} tracking={-0.012} color={c.ink} style={{ fontFamily: FONT.display, marginTop: 3 }}>
                  {count.lineCount}
                </Mono>
              </View>
              <View>
                <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
                  VARIANCES
                </Mono>
                <Mono
                  size={15}
                  tracking={-0.012}
                  color={count.variances > 0 ? ACCENT.warn : c.ink}
                  style={{ fontFamily: FONT.display, marginTop: 3 }}
                >
                  {count.variances}
                </Mono>
              </View>
            </View>
          </View>
          {count.variances === 0 ? <Pill status="ok">CLEAN</Pill> : <Pill status="warn">VARIANCE</Pill>}
        </View>
      </Card>
    </Pressable>
  );
}
