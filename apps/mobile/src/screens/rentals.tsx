import { useRouter } from 'expo-router';
import { PackageOpen, Plus } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Mono } from '@/components/ui/text';
import { showWriteCta } from '@/lib/cta-gating';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface RentalRow {
  id: string;
  status: string;
  borrower_name: string;
  borrower_email: string | null;
  checked_out_at: string;
  expected_return_at: string;
  returned_at: string | null;
  notes: string | null;
  warehouse: { name: string | null } | null;
}

/**
 * Rentals screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/rentals.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/rentals-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged. Extracted verbatim.
 */
export default function RentalsScreen() {
  const router = useRouter();
  // New-rental is a WRITE — hidden for rentals:read-only viewers (cosmetic;
  // the server enforces). Loading fallback shows, matching other screens.
  const perms = useEffectivePermissions();
  const canCreate = showWriteCta(perms, 'rentals:create');
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<RentalRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('rentals')
      .select(
        `id, status, borrower_name, borrower_email,
         checked_out_at, expected_return_at, returned_at, notes,
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', orgId)
      .order('checked_out_at', { ascending: false })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          status: r.status as string,
          borrower_name: r.borrower_name as string,
          borrower_email: (r.borrower_email as string | null) ?? null,
          checked_out_at: r.checked_out_at as string,
          expected_return_at: r.expected_return_at as string,
          returned_at: (r.returned_at as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          warehouse: Array.isArray(wh) ? wh[0] ?? null : wh,
        };
      }),
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

  const out = rows.filter((r) => r.status === 'out').length;
  const overdue = rows.filter(
    (r) => r.status === 'out' && new Date(r.expected_return_at) < new Date(),
  ).length;

  return (
    <DataListScreen
      eyebrow={`RENTALS · ${out} OUT${overdue > 0 ? ` · ${overdue} OVERDUE` : ''}`}
      title="Rental"
      italic="checkouts."
      emptyTitle="No rentals yet."
      emptyBody="Check out reusable assets (canopies, supplies, equipment) on the web. Track returns and overdue items here."
      emptyIcon={PackageOpen}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      trailing={canCreate ? <IconChip icon={Plus} onPress={() => router.push('/rentals/new')} /> : undefined}
      keyExtractor={(r) => r.id}
      renderItem={(r) => <RentalCard rental={r} />}
    />
  );
}

function RentalCard({ rental }: { rental: RentalRow }) {
  const { c } = useTheme();
  const now = Date.now();
  const isOverdue =
    rental.status === 'out' && new Date(rental.expected_return_at).getTime() < now;
  const pill =
    rental.status === 'returned' ? (
      <Pill status="ok">RETURNED</Pill>
    ) : rental.status === 'cancelled' ? (
      <Pill status="crit">CANCELLED</Pill>
    ) : isOverdue ? (
      <Pill status="crit">OVERDUE</Pill>
    ) : (
      <Pill status="warn">OUT</Pill>
    );

  function openOnWeb() {
    Linking.openURL(`https://stockpilotusa.com/dashboard/rentals/${rental.id}`).catch(() => undefined);
  }

  return (
    <Pressable onPress={openOnWeb} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {rental.warehouse?.name ? (
              <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
                — {rental.warehouse.name}
              </Mono>
            ) : null}
            <Body size={15} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
              {rental.borrower_name}
            </Body>
            <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              out {new Date(rental.checked_out_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              {' · due '}
              {new Date(rental.expected_return_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Mono>
          </View>
          {pill}
        </View>
      </Card>
    </Pressable>
  );
}
