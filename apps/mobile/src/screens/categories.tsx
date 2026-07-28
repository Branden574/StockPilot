import { Tag } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  parent_id: string | null;
  itemCount: number;
}

interface HierarchyRow extends Category {
  /** 0 = a root category, 1 = its direct child. Categories are a parent/child
   *  PAIR (packages/core/src/sports/tracking-modes.ts / migration 0294's
   *  category_tracking_mode header), never a deeper tree, but the walk below
   *  stays generic rather than assuming exactly two levels. */
  depth: number;
}

/**
 * Flattens the parent/child rows into a single ordered list a FlatList can
 * render directly: every root, immediately followed by its own children
 * (each carrying `depth` for indentation), both alphabetized. Task 12: the
 * screen used to render every row flat regardless of `parent_id` — this is
 * what "render the hierarchy" means on a plain FlatList.
 */
function buildHierarchy(rows: Category[]): HierarchyRow[] {
  const byParent = new Map<string | null, Category[]>();
  for (const r of rows) {
    const key = r.parent_id;
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
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function Categories() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<Category[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('categories')
      .select('id, name, description, color, parent_id')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('name', { ascending: true });

    // Count items per category in one round trip so the row tells the
    // user how big each category is. RLS limits to their org.
    const { data: counts } = await supabase
      .from('inventory_items')
      .select('category_id')
      .eq('organization_id', orgId)
      .is('deleted_at', null);
    const byCat = new Map<string, number>();
    for (const r of (counts ?? []) as Array<{ category_id: string | null }>) {
      if (r.category_id) byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + 1);
    }

    setRows(
      ((data ?? []) as Category[]).map((c) => ({ ...c, itemCount: byCat.get(c.id) ?? 0 })),
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

  const hierarchy = React.useMemo(() => buildHierarchy(rows), [rows]);

  return (
    <DataListScreen
      eyebrow={`ORGANIZE · ${rows.length} CATEGORIES`}
      title="Categories"
      italic="& taxonomies."
      emptyTitle="No categories yet."
      emptyBody="Create categories on the web to organize items by type."
      emptyIcon={Tag}
      data={hierarchy}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <CategoryCard category={c} depth={c.depth} />}
    />
  );
}

/** `depth` indents a subcategory under its parent (Task 12) — 0 for a root, 1
 *  for its direct child. A smaller swatch + left inset is the only visual
 *  difference; a root with no children renders byte-identical to before. */
function CategoryCard({ category, depth = 0 }: { category: Category; depth?: number }) {
  const { c } = useTheme();
  const swatch = category.color ?? '#8b8c83';
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
              backgroundColor: c.paper2,
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
          <Mono size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
            {category.itemCount}
          </Mono>
        </View>
      </Card>
    </View>
  );
}
