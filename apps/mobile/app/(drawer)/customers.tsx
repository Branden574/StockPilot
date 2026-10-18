import { Handshake } from 'lucide-react-native';
import * as React from 'react';
import { Alert, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Toggle } from '@/components/ui/toggle';
import { Body, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
import { useTheme } from '@/lib/use-theme';

interface CustomerRow {
  id: string;
  name: string;
  status: 'active' | 'archived';
  price_list: { name: string | null } | { name: string | null }[] | null;
  customer_users: { count: number }[] | null;
  customer_catalog: { count: number }[] | null;
}

/**
 * The accounts list's failed read, in its own words (redesign defect D25: a
 * failed read used to say "No accounts yet."). Accounts an earlier read left
 * on screen stay, with the reload note above them.
 */
const ACCOUNTS_LOAD_FAILED = {
  title: 'Could not load accounts.',
  body: 'Check your connection and pull down to try again.',
  reloadNote: 'Could not load accounts again, so these may be out of date. Pull down to try again.',
};

/**
 * B2B customers — mobile twin of /dashboard/customers (read + activate/archive;
 * price lists, catalogs, and invites stay web-side where the editors live).
 * Direct Supabase under the 0250 RLS floor (member read, manager-or-
 * customers:manage write); the drawer entry is gated to customers:manage.
 */
export default function CustomersScreen() {
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const [rows, setRows] = React.useState<CustomerRow[]>([]);
  // The last read failed (set by every read that answers).
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!user || !activeOrgId) return;
    const { data, error } = await supabase
      .from('customers')
      .select(
        'id, name, status, price_list:price_lists(name), customer_users(count), customer_catalog(count)',
      )
      .eq('organization_id', activeOrgId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      // Said, never "No accounts yet."; earlier rows stay.
      setLoadFailed(true);
    } else {
      setLoadFailed(false);
      setRows((data ?? []) as CustomerRow[]);
    }
    setLoading(false);
  }, [user, activeOrgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function setStatus(row: CustomerRow, active: boolean) {
    setBusyId(row.id);
    // Await the builder + row-hit check (bug patterns #22 + fail-open update).
    const { error, data } = await supabase
      .from('customers')
      .update({ status: active ? 'active' : 'archived' })
      .eq('id', row.id)
      .eq('organization_id', activeOrgId ?? '')
      .select('id')
      .maybeSingle();
    setBusyId(null);
    if (error || !data) {
      Alert.alert(
        'Could not update',
        error?.message ?? 'You need manager access to change accounts.',
      );
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, status: active ? 'active' : 'archived' } : r)),
    );
  }

  return (
    <DataListScreen
      // A read that failed with nothing on screen quotes no count.
      eyebrow={
        loadFailed && rows.length === 0
          ? 'B2B'
          : `B2B · ${rows.filter((r) => r.status === 'active').length} ACTIVE`
      }
      title="Accounts"
      italic="."
      emptyTitle="No accounts yet."
      emptyBody="Create B2B accounts on the web dashboard (Accounts) — assign a price list and catalog, invite portal users, and their orders flow into your normal approval queue."
      emptyIcon={Handshake}
      failed={loadFailed ? ACCOUNTS_LOAD_FAILED : null}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(c) => c.id}
      renderItem={(c) => (
        <CustomerCard
          row={c}
          busy={busyId === c.id}
          onToggle={(active) => void setStatus(c, active)}
        />
      )}
    />
  );
}

function CustomerCard({
  row,
  busy,
  onToggle,
}: {
  row: CustomerRow;
  busy: boolean;
  onToggle: (active: boolean) => void;
}) {
  const { c } = useTheme();
  const plObj = Array.isArray(row.price_list) ? row.price_list[0] : row.price_list;
  const users = row.customer_users?.[0]?.count ?? 0;
  const catalog = row.customer_catalog?.[0]?.count ?? 0;
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} numberOfLines={1}>
            {row.name}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}>
            {[
              plObj?.name ?? 'No price list',
              `${users} user${users === 1 ? '' : 's'}`,
              `${catalog} item${catalog === 1 ? '' : 's'}`,
            ].join(' · ')}
          </Mono>
        </View>
        <Pill status={row.status === 'active' ? 'ok' : 'default'}>
          {row.status === 'active' ? 'Active' : 'Archived'}
        </Pill>
        {/* No label sits beside the switch, so it is named for its row. */}
        <Toggle
          value={row.status === 'active'}
          onValueChange={busy ? undefined : onToggle}
          accessibilityLabel={row.name}
        />
      </View>
    </Card>
  );
}
