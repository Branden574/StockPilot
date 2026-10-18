import { Tags } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface TagRow {
  id: string;
  name: string;
  color: string | null;
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
 * read is never "No tags yet." (redesign defect D25): it keeps the rows this
 * workspace already shows, marked failed so the screen says so above them, or
 * with none it is the failure itself. Another workspace's rows are never kept.
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
 * Tags screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/tags.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/tags-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * A failed read says so (DataListScreen's `failed`), never "No tags yet."; a
 * refresh that fails keeps the list and says so above it; with no workspace a
 * pull loads it again, as the Locations list does.
 */
export default function TagsScreen() {
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<TagRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: TagRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('tags')
        .select('id, name, color')
        .eq('organization_id', orgId)
        .order('name', { ascending: true });
      if (error) throw error;
      rows = (data ?? []) as TagRow[];
    } catch (e) {
      console.warn('[tags] load failed:', e instanceof Error ? e.message : e);
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
      eyebrow={list === null || failedEmpty ? 'ORGANIZE · TAGS' : `ORGANIZE · ${rows.length} TAGS`}
      title="Tags"
      italic="& flags."
      emptyTitle="No tags yet."
      emptyBody="Tag items on the web for ad-hoc grouping like clearance or watchlist."
      emptyIcon={Tags}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load tags.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the tags. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(t) => t.id}
      renderItem={(t) => <TagCard tag={t} />}
    />
  );
}

/** One tag: its colour as a round swatch, ringed in the stronger border so a
 *  white or pale tag colour still shows on the card; a tag with no colour of
 *  its own shows a muted ink3 mark (6.5:1 or more on the card). */
function TagCard({ tag }: { tag: TagRow }) {
  const { c } = useTheme();
  const swatch = tag.color ?? c.ink3;
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 999,
            backgroundColor: swatch,
            borderWidth: 1,
            borderColor: c.hair2,
          }}
        />
        <Body size={15} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
          {tag.name}
        </Body>
      </View>
    </Card>
  );
}
