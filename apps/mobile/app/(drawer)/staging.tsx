import { useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, History, LayoutList, Menu } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { can, type Role } from '@stockpilot/core';

import { ItemHistorySheet } from '@/components/item-history-sheet';
import { MoveStockModal } from '@/components/move-stock-modal';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import {
  canPlaceStagingRow,
  isStagingStale,
  parseStagingWorklist,
  STAGING_STALE_LABEL,
  STAGING_TYPE_OPTIONS,
  stagingAgeLabel,
  stagingCountLabel,
  stagingPlaceDisabledReason,
  stagingReceivedLabel,
  stagingRowKey,
  stagingSourceKindLabel,
  stagingSourceLabel,
  stagingWarehouseLabel,
  stagingWarehouseNameMap,
  stagingWorklistPath,
  type StagingTypeFilter,
  type StagingWarehouseOption,
  type StagingWorklistRow,
} from '@/lib/staging-worklist';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * Staging — the native twin of the web /dashboard/inventory/staging page.
 *
 * Put-away is done on foot, in the aisle, and until now it could only be done
 * at a desk. This screen lists every not-yet-placed holding (staged = arrived
 * from a PO, unplaced = on hand but never racked), says in WORDS where each one
 * came from, and places it into a rack or crate.
 *
 * Two things it deliberately does NOT do:
 *  • it does not query Supabase for the worklist. It reads
 *    GET /api/v1/inventory/staging, which calls the very same
 *    InventoryService.stagedWorklist() the web page renders — the 2026-07-22
 *    incident was two surfaces disagreeing about where stock came from, and a
 *    second query here would rebuild that disagreement; and
 *  • it does not word any cell for itself. Source PO/receipt, received date,
 *    age, staleness, the staged/unplaced badge and the warehouse all come from
 *    src/lib/staging-worklist.ts, whose formatters mirror the web staging table
 *    cell for cell — including the em dash web shows for an unknown value. The
 *    owner reads the two side by side.
 *
 * The History action opens ItemHistorySheet, which reads
 * GET /api/v1/items/[id]/history — the same shared service the web dialog
 * renders. It answers the question the em dash could not ("who moved them,
 * when, where, why") by showing the ledger rows AS THEY ARE, and it touches
 * nothing on this list: the source PO/receipt, the received date and the age /
 * Stale badge above are still exactly what stagedWorklist() returned.
 *
 * The Place action goes through MoveStockModal → POST /api/v1/items/[id]/
 * transfer (never the transfer_stock RPC, which only checks the staff-role
 * floor), so 'stock:transfer' is enforced server-side. `canPlace` from the
 * endpoint gates the button so nobody is shown a control that always 403s.
 *
 * All display logic that can be tested without a renderer lives in
 * src/lib/staging-worklist.ts (see its test); this file is fetch + paint.
 */
export default function StagingScreen() {
  const { c } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { orgId } = useOrg();
  // The drawer switcher's warehouse pick. Every other list screen narrows by
  // it, and the web staging page narrows by its cookie twin — without this the
  // phone would answer a different question than the browser for the same user.
  const { activeWarehouseId } = useWorkspace();
  const { role } = useRole();
  const permissions = useEffectivePermissions();

  const [filter, setFilter] = React.useState<StagingTypeFilter>('all');
  const [rows, setRows] = React.useState<StagingWorklistRow[]>([]);
  const [canPlace, setCanPlace] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [placing, setPlacing] = React.useState<StagingWorklistRow | null>(null);
  // The row whose movement history is open. Read-only and gated by nothing
  // beyond 'items:read' (the route asserts it), so every user who can see a
  // staging row can see how that stock got there.
  const [viewingHistory, setViewingHistory] = React.useState<StagingWorklistRow | null>(null);

  // warehouseId → name, the mobile twin of the web page's `warehouseNames`
  // prop. A row whose warehouse is missing here (archived/inactive) falls back
  // to the same truncated id the web table shows.
  //
  // Read from the warehouses table with the SAME predicate web's
  // WarehousesService.listNames() uses (status = 'active'), NOT from the drawer
  // switcher's list: that one keeps inactive warehouses so you can still switch
  // to them, and feeding it here made an inactive warehouse print a name on the
  // phone and a truncated UUID in the browser for the same row. This is the
  // ONLY Supabase read on this screen and it is a display map, never the
  // worklist — the worklist must stay the shared service's answer.
  const [warehouseNames, setWarehouseNames] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('warehouses')
        .select('id, name, status')
        .eq('organization_id', orgId)
        .eq('status', 'active')
        .order('name', { ascending: true });
      if (cancelled) return;
      setWarehouseNames(stagingWarehouseNameMap((data ?? []) as StagingWarehouseOption[]));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Gates the inline "+ New rack" branch inside the move sheet; the transfer
  // route asserts 'locations:manage' independently when it creates the rack.
  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canCreateLocation =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'locations:manage'));

  // Monotonic sequence guard: switching the Items/Books filter fires a new
  // request while the previous one is still in flight, and the slower response
  // must never overwrite the newer list.
  const seqRef = React.useRef(0);

  // orgId is never sent explicitly — api() attaches X-Organization-Id from the
  // persisted active workspace — but it is both a GUARD and a dependency here:
  // asking before the switcher has resolved an org would answer for whatever
  // org was persisted last, and switching workspaces must re-fetch or the phone
  // keeps showing the previous org's worklist. Returning early (rather than
  // clearing) holds the spinner instead of flashing "Nothing to place" on a
  // cold launch, matching every other list screen's `if (!orgId) return`.
  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    try {
      const res = await api<unknown>(stagingWorklistPath(filter, activeWarehouseId));
      if (seq !== seqRef.current) return;
      const parsed = parseStagingWorklist(res);
      setRows(parsed.rows);
      setCanPlace(parsed.canPlace);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setCanPlace(false);
      setError(e instanceof Error ? e.message : 'Could not load the staging worklist.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [filter, activeWarehouseId, orgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loader spinner reset: this effect re-runs on filter/warehouse/org changes and must sync-show the spinner before load()'s post-await sets; loading already initializes true so the mount run is a no-op re-set
    setLoading(true);
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
        </View>
        <View style={styles.head}>
          <Eyebrow>
            {loading ? 'PUT AWAY' : `PUT AWAY · ${stagingCountLabel(rows.length)}`}
          </Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Staging <Em>worklist.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {/* The list stays mounted while loading — swapping it for a full-screen
          spinner would unmount the Items/Books toolbar on every tap, so the
          user could not see which filter is active or correct a mistap until
          the request came back. Only the BODY shows the spinner. */}
      <FlatList
        data={loading ? [] : rows}
        keyExtractor={(row) => stagingRowKey(row)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />
        }
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 2 }}>
            <View style={styles.filterRow}>
              {STAGING_TYPE_OPTIONS.map((opt) => {
                const active = opt.value === filter;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setFilter(opt.value)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: active ? c.ink : c.hair,
                      backgroundColor: active ? c.ink : c.card,
                    }}
                  >
                    <Mono size={12} color={active ? c.card : c.ink2}>
                      {opt.label}
                    </Mono>
                  </Pressable>
                );
              })}
            </View>
            {error ? (
              <Mono size={11.5} color={ACCENT.crit}>
                {error}
              </Mono>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
          ) : error ? (
            // The failure itself is already spelled out above the list. Do NOT
            // also claim "Nothing to place" here — an unread request is not an
            // empty worklist, and conflating the two is the same category of
            // lie as the em dash this screen exists to remove.
            <View style={styles.empty}>
              <Body muted style={{ textAlign: 'center', maxWidth: 320 }}>
                Pull down to try again.
              </Body>
            </View>
          ) : (
            <View style={styles.empty}>
              <View style={{ marginBottom: 12 }}>
                <LayoutList size={32} color={c.ink4} strokeWidth={1.3} />
              </View>
              <Display size={18}>Nothing to place.</Display>
              {/* Same sentence the web table's empty state uses. */}
              <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                Received (staged) or unplaced stock appears here.
              </Body>
            </View>
          )
        }
        renderItem={({ item }) => (
          <StagingCard
            row={item}
            warehouseNames={warehouseNames}
            canPlace={canPlaceStagingRow(item, canPlace)}
            // Web shows a DISABLED Place with a reason for a row it cannot
            // place; showing no control at all reads as "this row is somehow
            // different" instead of "this row cannot be placed, and here is why".
            disabledReason={stagingPlaceDisabledReason(item, canPlace)}
            onOpenItem={() =>
              router.push({ pathname: '/item/[id]', params: { id: item.itemId } })
            }
            onPlace={() => setPlacing(item)}
            onOpenHistory={() => setViewingHistory(item)}
          />
        )}
      />

      {placing && orgId ? (
        <MoveStockModal
          visible
          itemId={placing.itemId}
          itemName={placing.name}
          itemType={placing.itemType || null}
          organizationId={orgId}
          // Put-away mode. The source is FIXED to the holding this row
          // represents — the sheet renders no source picker at all, exactly like
          // the web PlaceFromStagingDialog. That is the whole fix: with no way
          // to change the source, a cross-warehouse "put-away" is not something
          // the phone can express, the whole-holding quantity default has one
          // unambiguous subject, and the destination scope is derived from this
          // holding rather than remembered next to it. Nothing else is passed —
          // the warehouse comes off the holding itself inside the sheet, so the
          // two cannot disagree.
          putAwaySourceLocationId={placing.sourceLocationId}
          // The book's recorded rack/crate, straight off the worklist row the
          // endpoint sent. It SEEDS the sheet's four destination fields, so the
          // default put-away goes INTO the crate the book already records, on
          // the rack it records — never the bare rack that clears it (Maus I).
          bookStorage={placing.bookStorage}
          canCreateLocation={canCreateLocation}
          onClose={() => setPlacing(null)}
          onMoved={() => {
            setPlacing(null);
            void load();
          }}
        />
      ) : null}

      {viewingHistory ? (
        <ItemHistorySheet
          visible
          itemId={viewingHistory.itemId}
          // The list's own name/sku, so the sheet opens with a title instead of
          // a blank while the first page is in flight.
          itemName={viewingHistory.name}
          itemSku={viewingHistory.sku}
          onClose={() => setViewingHistory(null)}
        />
      ) : null}
    </View>
  );
}

function StagingCard({
  row,
  warehouseNames,
  canPlace,
  disabledReason,
  onOpenItem,
  onPlace,
  onOpenHistory,
}: {
  row: StagingWorklistRow;
  warehouseNames: Record<string, string>;
  canPlace: boolean;
  /** Non-null when the row is visible-but-unplaceable — rendered next to a
   *  disabled Place, mirroring the web button's tooltip. */
  disabledReason: string | null;
  onOpenItem: () => void;
  onPlace: () => void;
  onOpenHistory: () => void;
}) {
  const { c } = useTheme();
  const age = stagingAgeLabel(row.ageDays);
  const stale = isStagingStale(row.ageDays);

  return (
    <Card padding={14}>
      <Pressable onPress={onOpenItem} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }} numberOfLines={2}>
              {row.name}
            </Body>
            <View style={styles.metaRow}>
              <Mono size={10.5} color={c.ink4}>
                {row.sku}
              </Mono>
              <Pill dot={false} status={row.sourceKind === 'unplaced' ? 'warn' : 'default'}>
                {stagingSourceKindLabel(row.sourceKind)}
              </Pill>
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Display size={22}>{row.quantity}</Display>
            <Mono size={9} tracking={0.14} upper color={c.ink4} style={{ marginTop: 2 }}>
              TO PLACE
            </Mono>
          </View>
        </View>

        {/* The web table's Source PO / receipt, Received and Warehouse cells,
            in the same words — including the em dash for an unknown value,
            which is what web renders rather than an empty cell. */}
        <View style={{ marginTop: 12, gap: 6 }}>
          <CardField
            label="SOURCE PO / RECEIPT"
            value={stagingSourceLabel(row.sourcePoNumber, row.receiptNumber)}
          />
          <CardField label="RECEIVED" value={stagingReceivedLabel(row.receivedAt)} />
          <CardField
            label="WAREHOUSE"
            value={stagingWarehouseLabel(row.warehouseId, warehouseNames)}
          />
        </View>
      </Pressable>

      <View style={styles.footer}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Mono size={11} color={stale ? ACCENT.crit : c.ink4}>
            {age}
          </Mono>
          {stale ? (
            // Same "Stale" call-out the web table shows past the shared
            // 7-day threshold. Pill carries the crit palette for both themes.
            <Pill status="crit">{STAGING_STALE_LABEL}</Pill>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexShrink: 1 }}>
          {/* History is offered on EVERY row, including one that cannot be
              placed: "where did this come from" is exactly the question a row
              with no PO and no warehouse raises, and it is a read — the route
              asserts only 'items:read', which the user already has to be
              looking at this list. */}
          <Button
            size="sm"
            variant="ghost"
            onPress={onOpenHistory}
            leading={<History size={14} color={c.ink} strokeWidth={1.6} />}
          >
            History
          </Button>
          {canPlace ? (
            <Button size="sm" variant="outline" onPress={onPlace}>
              Place
            </Button>
          ) : disabledReason ? (
            <View style={{ alignItems: 'flex-end', gap: 4, flexShrink: 1 }}>
              <Button size="sm" variant="outline" disabled>
                Place
              </Button>
              {/* The web button carries this as a tooltip; a phone has no hover,
                  so the same words go on screen. */}
              <Mono size={9.5} color={c.ink4} style={{ textAlign: 'right' }}>
                {disabledReason}
              </Mono>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/**
 * One label/value pair — the phone's stand-in for a web table column, since a
 * 375pt screen cannot carry seven columns side by side. The VALUE text is
 * whatever the shared formatter returned, never re-worded here.
 */
function CardField({ label, value }: { label: string; value: string }) {
  const { c } = useTheme();
  return (
    <View style={styles.fieldRow}>
      <Mono size={9.5} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <Mono size={11.5} color={c.ink2} style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Mono>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 10,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
  },
  empty: {
    paddingTop: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    minHeight: 36,
  },
});
