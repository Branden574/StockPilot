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

  return (
    <DataListScreen
      eyebrow={`ORGANIZE · ${rows.length} CATEGORIES`}
      title="Categories"
      italic="& taxonomies."
      emptyTitle="No categories yet."
      emptyBody="Create categories on the web to organize items by type."
      emptyIcon={Tag}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <CategoryCard category={c} />}
    />
  );
}

function CategoryCard({ category }: { category: Category }) {
  const { c } = useTheme();
  const swatch = category.color ?? '#8b8c83';
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          style={{
            width: 32,
            height: 32,
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
              width: 14,
              height: 14,
              borderRadius: 3,
              backgroundColor: swatch,
            }}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
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
  );
}
