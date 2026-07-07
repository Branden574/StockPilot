import { Tags } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface TagRow {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Tags screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/tags.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/tags-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function TagsScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<TagRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('tags')
      .select('id, name, color')
      .eq('organization_id', orgId)
      .order('name', { ascending: true });
    setRows((data ?? []) as TagRow[]);
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
      eyebrow={`ORGANIZE · ${rows.length} TAGS`}
      title="Tags"
      italic="& flags."
      emptyTitle="No tags yet."
      emptyBody="Tag items on the web for ad-hoc grouping like clearance or watchlist."
      emptyIcon={Tags}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(t) => t.id}
      renderItem={(t) => <TagCard tag={t} />}
    />
  );
}

function TagCard({ tag }: { tag: TagRow }) {
  const { c } = useTheme();
  const swatch = tag.color ?? '#8b8c83';
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
            borderColor: c.hair,
          }}
        />
        <Body size={15} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
          {tag.name}
        </Body>
      </View>
    </Card>
  );
}
