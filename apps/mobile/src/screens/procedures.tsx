import { BookOpen } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface ProcedureRow {
  id: string;
  title: string;
  description: string | null;
  updated_at: string;
  category: { name: string | null } | null;
}

/**
 * Procedures screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/procedures.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/procedures-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function ProceduresScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<ProcedureRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('procedures')
      .select(
        `id, title, description, updated_at,
         category:procedure_categories!category_id (name)`,
      )
      .eq('organization_id', orgId)
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const cat = r.category as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          title: r.title as string,
          description: (r.description as string | null) ?? null,
          updated_at: r.updated_at as string,
          category: Array.isArray(cat) ? cat[0] ?? null : cat,
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
      eyebrow={`OPERATIONS · ${rows.length} SOPS`}
      title="Standard"
      italic="procedures."
      emptyTitle="No procedures yet."
      emptyBody="Write SOPs on the web — counting routines, intake checklists, packing rituals — and reference them from the floor here."
      emptyIcon={BookOpen}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(p) => p.id}
      renderItem={(p) => <ProcedureCard proc={p} />}
    />
  );
}

function ProcedureCard({ proc }: { proc: ProcedureRow }) {
  const { c } = useTheme();
  function openOnWeb() {
    Linking.openURL(`https://stockpilotusa.com/dashboard/procedures/${proc.id}`).catch(() => undefined);
  }
  return (
    <Pressable onPress={openOnWeb} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
              {proc.title}
            </Body>
            {proc.description ? (
              <Body muted size={12.5} style={{ marginTop: 4 }}>
                {proc.description}
              </Body>
            ) : null}
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 8 }}>
              updated {new Date(proc.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Mono>
          </View>
          {proc.category?.name ? <Pill>{proc.category.name.toUpperCase()}</Pill> : null}
        </View>
      </Card>
    </Pressable>
  );
}
