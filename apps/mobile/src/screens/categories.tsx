import { Tag } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { countItemsByCategory } from '@/lib/category-counts';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  parent_id: string | null;
  /** null = the tally could not be read (see load()). Rendered as an em dash,
   *  never as `0` — a confident zero next to a category that plainly has stock
   *  is worse than admitting the number is unknown. */
  itemCount: number | null;
}

interface HierarchyRow extends Category {
  /** 0 = a root category, 1 = its direct child. Categories are a parent/child
   *  PAIR (packages/core/src/sports/tracking-modes.ts / migration 0294's
   *  category_tracking_mode header), never a deeper tree, but the walk below
   *  stays generic rather than assuming exactly two levels. */
  depth: number;
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
 * read is never "No categories yet." (redesign defect D25): it keeps the rows
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
 * Flattens the parent/child rows into a single ordered list a FlatList can
 * render directly: every root, immediately followed by its own children
 * (each carrying `depth` for indentation), both alphabetized. Task 12: the
 * screen used to render every row flat regardless of `parent_id` — this is
 * what "render the hierarchy" means on a plain FlatList.
 */
function buildHierarchy(rows: Category[]): HierarchyRow[] {
  // A child is nested under its parent only when that parent is in THIS list.
  // The walk starts at null, so a child whose parent is missing (archived, or
  // filtered out) would never be reached at all — it is promoted to a root
  // instead, so no category can silently disappear from the screen.
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<string | null, Category[]>();
  for (const r of rows) {
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const out: HierarchyRow[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const r of byParent.get(parentId) ?? []) {
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

/**
 * Categories screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/categories.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/categories-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * A failed read says so (DataListScreen's `failed`), never "No categories
 * yet."; a refresh that fails keeps the list and says so above it; with no
 * workspace a pull loads it again, as the Locations list does.
 */
export default function Categories() {
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<Category> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: Category[] | null = null;
    try {
      const { data, error } = await supabase
        .from('categories')
        .select('id, name, description, color, parent_id')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .order('name', { ascending: true });
      if (error) throw error;

      // Count items per category so the row tells the user how big each
      // category is. RLS limits to their org.
      //
      // SP-072: this used to be ONE un-ranged `.select('category_id')` over the
      // whole org, tallied here. PostgREST clamps every response to
      // `[api] max_rows = 1000` with no error and no marker, so past 1000 live
      // items the badges silently undercounted and categories whose rows sorted
      // past the cap showed `0`. countItemsByCategory() walks 1000-row windows
      // and fails CLOSED, so we either get the whole tally or none of it.
      const { data: counts } = await countItemsByCategory(supabase, orgId);

      rows = ((data ?? []) as Omit<Category, 'itemCount'>[]).map((c) => ({
        ...c,
        // `counts` is null only when the read failed or the org is past the
        // page ceiling; `?? 0` there would invent a wrong number for every row.
        itemCount: counts ? (counts.get(c.id) ?? 0) : null,
      }));
    } catch (e) {
      console.warn('[categories] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only rows read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = React.useMemo(() => list?.rows ?? [], [list]);
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

  const hierarchy = React.useMemo(() => buildHierarchy(rows), [rows]);

  return (
    <DataListScreen
      eyebrow={
        list === null || failedEmpty
          ? 'ORGANIZE · CATEGORIES'
          : `ORGANIZE · ${rows.length} CATEGORIES`
      }
      title="Categories"
      italic="& taxonomies."
      emptyTitle="No categories yet."
      emptyBody="Create categories on the web to organize items by type."
      emptyIcon={Tag}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load categories.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the categories. Pull down to try again.',
              }
            : null
      }
      data={hierarchy}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <CategoryCard category={c} depth={c.depth} />}
    />
  );
}

/** `depth` indents a subcategory under its parent (Task 12) — 0 for a root, 1
 *  for its direct child. A smaller swatch + left inset is the only visual
 *  difference. The swatch sits in a recessed well (sunk, the reference's
 *  inset fill; paper2 is the card colour in dark and drew nothing there); a
 *  category with no colour of its own shows a muted ink3 mark (6:1 or more on
 *  the well; the old fixed grey was the faint ink4, 3.0:1 on it in light). */
function CategoryCard({ category, depth = 0 }: { category: Category; depth?: number }) {
  const { c } = useTheme();
  const swatch = category.color ?? c.ink3;
  const isChild = depth > 0;
  return (
    <View style={{ marginLeft: depth * 20 }}>
      <Card padding={isChild ? 12 : 14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View
            style={{
              width: isChild ? 26 : 32,
              height: isChild ? 26 : 32,
              borderRadius: 8,
              backgroundColor: c.sunk,
              borderWidth: 1,
              borderColor: c.hair,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: isChild ? 11 : 14,
                height: isChild ? 11 : 14,
                borderRadius: 3,
                backgroundColor: swatch,
              }}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={isChild ? 14 : 15} color={c.ink} style={{ fontFamily: FONT.display }}>
              {category.name}
            </Body>
            {category.description ? (
              <Body muted size={12.5} style={{ marginTop: 3 }}>
                {category.description}
              </Body>
            ) : null}
          </View>
          {/* The count is a quantity: mono, the reference's figure face. The
              dash for a tally that could not be read is muted ink3. */}
          <Mono size={14} color={category.itemCount === null ? c.ink3 : c.ink}>
            {category.itemCount ?? '—'}
          </Mono>
        </View>
      </Card>
    </View>
  );
}
