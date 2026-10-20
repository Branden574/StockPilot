import { BookOpen } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
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

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "No procedures yet." (redesign defect D25): it keeps the rows
 * this workspace already shows, marked failed so the screen says so above
 * them, or with none it is the failure itself. Another workspace's rows are
 * never kept.
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
 * Procedures screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/procedures.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/procedures-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * A card opens the procedure on the web (there is no phone procedure page). A
 * failed read says so (DataListScreen's `failed`), never "No procedures
 * yet."; a refresh that fails keeps the list and says so above it; with no
 * workspace a pull loads it again, as the Locations list does.
 */
export default function ProceduresScreen() {
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<ProcedureRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: ProcedureRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('procedures')
        .select(
          `id, title, description, updated_at,
           category:procedure_categories!category_id (name)`,
        )
        .eq('organization_id', orgId)
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        .limit(100);
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);
      rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const cat = r.category as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          title: r.title as string,
          description: (r.description as string | null) ?? null,
          updated_at: r.updated_at as string,
          category: Array.isArray(cat) ? (cat[0] ?? null) : cat,
        };
      });
    } catch (e) {
      console.warn('[procedures] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only rows read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = list?.rows ?? [];
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again).
  const noWorkspace = !orgId && !workspaceLoading;
  const failedEmpty = noWorkspace || (list !== null && list.failed && rows.length === 0);

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
      eyebrow={
        list === null || failedEmpty ? 'OPERATIONS · SOPS' : `OPERATIONS · ${rows.length} SOPS`
      }
      title="Standard"
      italic="procedures."
      emptyTitle="No procedures yet."
      emptyBody="Write SOPs on the web — counting routines, intake checklists, packing rituals — and reference them from the floor here."
      emptyIcon={BookOpen}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load procedures.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the procedures. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(p) => p.id}
      renderItem={(p) => <ProcedureCard proc={p} />}
    />
  );
}

function ProcedureCard({ proc }: { proc: ProcedureRow }) {
  const { c } = useTheme();
  function openOnWeb() {
    Linking.openURL(`https://stockpilotusa.com/dashboard/procedures/${proc.id}`).catch(
      () => undefined,
    );
  }
  return (
    <Pressable
      onPress={openOnWeb}
      // A button to VoiceOver (it read the card's words with no trait), and
      // where a tap goes: out of the app, to the web page.
      accessibilityRole="button"
      accessibilityHint="Opens the procedure on the web"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
              {proc.title}
            </Body>
            {proc.description ? (
              <Body muted size={12.5} style={{ marginTop: 4 }}>
                {proc.description}
              </Body>
            ) : null}
            {/* Information (when it last changed), so muted ink3, never the
                faint ink4 it was drawn in (3.2-3.6:1). */}
            <Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 8 }}>
              updated{' '}
              {new Date(proc.updated_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </Mono>
          </View>
          {proc.category?.name ? <Pill>{proc.category.name.toUpperCase()}</Pill> : null}
        </View>
      </Card>
    </Pressable>
  );
}
