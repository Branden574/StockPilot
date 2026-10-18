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

/** No rows yet (one array, so an empty list keeps one identity). */
const NO_ROWS: CharterRow[] = [];

/**
 * Admin · Charters, read only. A read that fails is said as a failure, never
 * "No charters yet." (D25): with no rows its words stand in for the list,
 * with rows from an earlier read they stay under "Could not refresh", and the
 * eyebrow quotes no count it did not read.
 */
export default function CharterAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  // The rows on screen and the workspace they were read for: a failed read
  // keeps them only when they are this workspace's (never the last
  // workspace's rows under "Could not refresh" after a switch).
  const [list, setList] = React.useState<{ orgId: string; rows: CharterRow[] } | null>(null);
  const rows = list?.rows ?? NO_ROWS;
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // The last read failed (set by every read that completes).
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    const forOrg = orgId;
    let read;
    try {
      read = await supabase
        .from('charters')
        .select('id, name, code, description, status')
        .eq('organization_id', orgId)
        .order('name', { ascending: true });
    } catch {
      read = null;
    }
    if (!read || read.error) {
      setList((prev) => (prev !== null && prev.orgId === forOrg ? prev : null));
      setFailed(true);
      setLoading(false);
      return;
    }
    setFailed(false);
    setList({ orgId: forOrg, rows: (read.data ?? []) as CharterRow[] });
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
      eyebrow={failed && rows.length === 0 ? 'ADMIN · CHARTERS' : `ADMIN · ${rows.length} CHARTERS`}
      title="Charters"
      italic="."
      emptyTitle="No charters yet."
      emptyBody="Charters group warehouses into cost centers for reporting and routing."
      emptyIcon={Building2}
      failed={
        failed
          ? {
              title: 'Could not load charters.',
              body: 'Check your connection and pull down to try again.',
              reloadNote: 'Could not refresh. Showing the last list.',
            }
          : null
      }
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
            <Mono size={9.5} tracking={0.18} upper color={c.ink3}>
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
