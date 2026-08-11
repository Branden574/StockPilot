import { Building2 } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface CharterRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: string;
}

export default function CharterAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<CharterRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('charters')
      .select('id, name, code, description, status')
      .eq('organization_id', orgId)
      .order('name', { ascending: true });
    setRows((data ?? []) as CharterRow[]);
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
        eyebrow="ADMIN · CHARTERS"
        title="Restricted"
        italic="access."
        emptyIcon={Building2}
        emptyTitle="Admin only."
        emptyBody="Charters are gated to admins and owners."
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow={`ADMIN · ${rows.length} CHARTERS`}
      title="Charters"
      italic="."
      emptyTitle="No charters yet."
      emptyBody="Charters group warehouses into cost centers for reporting and routing."
      emptyIcon={Building2}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => <CharterCard charter={c} />}
    />
  );
}

function CharterCard({ charter }: { charter: CharterRow }) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {charter.code ? (
            <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
              — {charter.code}
            </Mono>
          ) : null}
          <Body size={15} color={c.ink} style={{ marginTop: charter.code ? 6 : 0, fontFamily: FONT.display }}>
            {charter.name}
          </Body>
          {charter.description ? (
            <Body muted size={12.5} style={{ marginTop: 4 }}>
              {charter.description}
            </Body>
          ) : null}
        </View>
        <Pill status={charter.status === 'active' ? 'ok' : 'warn'}>
          {charter.status.toUpperCase()}
        </Pill>
      </View>
    </Card>
  );
}
