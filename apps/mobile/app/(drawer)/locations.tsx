import { MapPin } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface LocationRow {
  id: string;
  name: string;
  type: string | null;
  parent_id: string | null;
  notes: string | null;
}

export default function LocationsScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<LocationRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('locations')
      .select('id, name, type, parent_id, notes')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('name', { ascending: true });
    setRows((data ?? []) as LocationRow[]);
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
      eyebrow={`WAREHOUSE · ${rows.length} LOCATIONS`}
      title="Locations"
      italic="& bins."
      emptyTitle="No locations yet."
      emptyBody="Locations group inventory by site, rack, row, or bin. Create them on the web."
      emptyIcon={MapPin}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(l) => l.id}
      renderItem={(l) => <LocationCard loc={l} />}
    />
  );
}

function LocationCard({ loc }: { loc: LocationRow }) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            backgroundColor: c.card,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <MapPin size={16} color={c.ink} strokeWidth={1.5} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {loc.name}
          </Body>
          {loc.notes ? (
            <Body muted size={12.5} style={{ marginTop: 3 }}>
              {loc.notes}
            </Body>
          ) : null}
        </View>
        {loc.type ? <Pill>{loc.type.toUpperCase()}</Pill> : null}
      </View>
    </Card>
  );
}
