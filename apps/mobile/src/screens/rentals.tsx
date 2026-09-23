import { inventoryDefaultLifecycle, rentalItemsPredicate } from '@stockpilot/core';
import { useRouter } from 'expo-router';
import { Boxes, PackageOpen, Plus } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Thumb } from '@/components/ui/thumb';
import { Body, Mono } from '@/components/ui/text';
import { showWriteCta } from '@/lib/cta-gating';
import { signListThumbnails } from '@/lib/image-cache';
import {
  RENTAL_ITEMS_LIMIT,
  loadRentalItemsView,
  rentalItemsViewEyebrow,
  type RentalItemRow,
  type RentalItemSource,
} from '@/lib/rental-items';
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
 *
 * TWO VIEWS, like web's Rentals tabs: Checkouts (the `rentals` table) and
 * Items (the rental inventory, see lib/rental-items.ts). Items is fetched the
 * first time it is opened, not on every visit to the screen.
 */
type RentalsView = 'checkouts' | 'items';

interface RentalItemsState {
  /** The org it was fetched for: a switch of organization makes it stale. */
  orgId: string;
  rows: RentalItemRow[];
  total: number | null;
  images: Map<string, string>;
  failed: boolean;
}

export default function RentalsScreen() {
  const router = useRouter();
  // New-rental is a WRITE — hidden for rentals:read-only viewers (cosmetic;
  // the server enforces). Loading fallback shows, matching other screens.
  const perms = useEffectivePermissions();
  const canCreate = showWriteCta(perms, 'rentals:create');
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<RentalRow[]>([]);
  // The checkouts read FAILED: not "No rentals yet.". Set by every load.
  const [checkoutsFailed, setCheckoutsFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [view, setView] = React.useState<RentalsView>('checkouts');
  const [items, setItems] = React.useState<RentalItemsState | null>(null);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    // Snapshot the clock with the data, not during render (compiler purity
    // rule): overdue badges refresh exactly when the list does - on mount and
    // pull-to-refresh - instead of whenever an unrelated re-render happens.
    setNow(Date.now());
    const { data, error } = await supabase
      .from('rentals')
      .select(
        `id, status, borrower_name, borrower_email,
         checked_out_at, expected_return_at, returned_at, notes,
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', orgId)
      .order('checked_out_at', { ascending: false })
      .limit(100);
    // A refused read used to render "No rentals yet.", a claim about the
    // org's checkouts made from an error.
    if (error) console.warn('rentals list', error);
    setCheckoutsFailed(Boolean(error));
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

  // The rental inventory. Same rule as web's Rentals -> Items: the shared
  // rental predicate, the default lifecycle (active, not awaiting a first
  // receipt), every warehouse, most recently updated first. Errors are BOUND:
  // an unreadable list must say so, never pose as "no rental items".
  const loadItems = React.useCallback(async () => {
    if (!orgId) return;
    const { data, error, count } = await supabase
      .from('inventory_items')
      .select('id, name, sku, quantity_on_hand', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('is_rental', rentalItemsPredicate.isRental)
      .eq('status', inventoryDefaultLifecycle.status)
      .eq('awaiting_first_receipt', inventoryDefaultLifecycle.awaitingFirstReceipt)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(RENTAL_ITEMS_LIMIT);
    if (error) {
      setItems({ orgId, rows: [], total: null, images: new Map(), failed: true });
      return;
    }
    const sources = (data ?? []) as RentalItemSource[];
    // Out on rental = open reservations; the photo is the primary one. Both
    // batched (200 ids is right at the local URL limit for one `.in()`).
    // Reservations feed Available and OVER-LENT, so a failure fails the view
    // (it used to be ignored, and Available silently equalled On hand); a
    // failed photo read leaves glyphs. See loadRentalItemsView.
    const view = await loadRentalItemsView(supabase, orgId, sources);
    if (view.failed) {
      console.warn('rental items reservations', view.message);
      // failed: true, so the eyebrow quotes no count for a list that did not
      // load (never "0 ITEMS" or "SHOWING 0 OF N"; rentalItemsViewEyebrow).
      setItems({ orgId, rows: [], total: null, images: new Map(), failed: true });
      return;
    }
    // The stored ~200px thumbnail where there is one, never the master (see
    // signListThumbnails and the Items tab).
    let signed = new Map<string, string>();
    try {
      signed = view.photoByItem.size
        ? await signListThumbnails(Array.from(view.photoByItem.values()))
        : signed;
    } catch {
      // A glyph instead of a photo; the row itself is still true.
    }
    const images = new Map<string, string>();
    for (const [itemId, photo] of view.photoByItem) {
      const url = signed.get(photo.storage_path);
      if (url) images.set(itemId, url);
    }
    setItems({
      orgId,
      rows: view.rows,
      total: count ?? null,
      images,
      failed: false,
    });
  }, [orgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await except the deliberate pre-await clock snapshot (setNow, documented in load); the effect synchronizes with the server
    void load();
  }, [load]);

  // Rows fetched for another organization are not this one's rental items.
  const current = items && items.orgId === orgId ? items : null;

  // First open of the Items view fetches it; after that pull-to-refresh does.
  React.useEffect(() => {
    if (view !== 'items' || current !== null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open: every set in loadItems is post-await; the effect synchronizes with the server
    void loadItems();
  }, [view, current, loadItems]);

  async function refresh() {
    setRefreshing(true);
    await (view === 'items' ? loadItems() : load());
    setRefreshing(false);
  }

  const viewSwitch = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Chip label="Checkouts" active={view === 'checkouts'} onPress={() => setView('checkouts')} />
      <Chip label="Items" active={view === 'items'} onPress={() => setView('items')} />
    </View>
  );

  if (view === 'items') {
    return (
      <DataListScreen<RentalItemRow>
        eyebrow={rentalItemsViewEyebrow(current)}
        title="Rental"
        italic="items."
        header={viewSwitch}
        emptyTitle={current?.failed ? 'Could not load rental items.' : 'No rental items yet.'}
        emptyBody={
          current?.failed
            ? 'Check your connection and pull down to try again.'
            : 'Rental items are the canopies, supplies and equipment staff check out. Add them on the web under Rentals.'
        }
        emptyIcon={Boxes}
        data={current?.rows ?? []}
        loading={current === null}
        refreshing={refreshing}
        onRefresh={refresh}
        keyExtractor={(r) => r.id}
        renderItem={(r) => (
          <RentalItemCard
            item={r}
            imageUrl={current?.images.get(r.id) ?? null}
            onPress={() => router.push(`/item/${r.id}`)}
          />
        )}
      />
    );
  }

  const out = rows.filter((r) => r.status === 'out').length;
  const overdue = rows.filter(
    (r) => r.status === 'out' && new Date(r.expected_return_at) < new Date(),
  ).length;

  return (
    <DataListScreen
      eyebrow={
        checkoutsFailed
          ? 'RENTALS · CHECKOUTS'
          : `RENTALS · ${out} OUT${overdue > 0 ? ` · ${overdue} OVERDUE` : ''}`
      }
      title="Rental"
      italic="checkouts."
      header={viewSwitch}
      emptyTitle={checkoutsFailed ? 'Could not load rentals.' : 'No rentals yet.'}
      emptyBody={
        checkoutsFailed
          ? 'Check your connection and pull down to try again.'
          : 'Check out reusable assets (canopies, supplies, equipment) on the web. Track returns and overdue items here.'
      }
      emptyIcon={PackageOpen}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      trailing={canCreate ? <IconChip icon={Plus} onPress={() => router.push('/rentals/new')} /> : undefined}
      keyExtractor={(r) => r.id}
      renderItem={(r) => <RentalCard rental={r} now={now} />}
    />
  );
}

function RentalCard({ rental, now }: { rental: RentalRow; now: number }) {
  const { c } = useTheme();
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

function RentalItemCard({
  item,
  imageUrl,
  onPress,
}: {
  item: RentalItemRow;
  imageUrl: string | null;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const pill = item.overReserved ? (
    <Pill status="crit">OVER-LENT</Pill>
  ) : item.onHand <= 0 ? (
    <Pill status="crit">NONE</Pill>
  ) : item.available <= 0 ? (
    <Pill status="warn">ALL OUT</Pill>
  ) : (
    <Pill status="ok">{`${item.available} FREE`}</Pill>
  );
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Thumb size={48} icon={Boxes} imageUrl={imageUrl} recyclingKey={item.id} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
              {item.name}
            </Body>
            <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 4 }}>
              {item.sku ?? 'No SKU'}
              {' · '}
              {item.onHand} on hand
              {item.reserved > 0 ? ` · ${item.reserved} out` : ''}
            </Mono>
          </View>
          {pill}
        </View>
      </Card>
    </Pressable>
  );
}

