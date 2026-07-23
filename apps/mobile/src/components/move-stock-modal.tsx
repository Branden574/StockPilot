import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Display, Eyebrow, Mono } from '@/components/ui/text';
import {
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  resolveMoveSource,
  type MoveDestination,
  type MoveHolding,
  type MoveSource,
} from '@/lib/move-stock-form';
import { transferStock } from '@/lib/stock-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

type Holding = MoveHolding;

/** Sentinel `toId` value for the inline "create a new rack" branch. */
const NEW_RACK = '__new__';

/** Colors this file reads off the theme palette — a subset of `useTheme().c`. */
type FieldColors = { ink: string; ink4: string; ink5: string; hair: string; paper2: string };

/**
 * A labeled text input for the inline "+ New rack" form. Defined at MODULE level
 * (not inside MoveStockModal) so its component identity is stable across
 * renders — a component re-created every render would remount its TextInput and
 * drop focus after each keystroke.
 */
function RackField({
  label,
  value,
  onChangeText,
  placeholder,
  c,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  c: FieldColors;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.ink5}
        style={{
          fontFamily: FONT.displayRegular,
          fontSize: 15,
          height: 46,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: c.hair,
          borderRadius: 8,
          color: c.ink,
          backgroundColor: c.paper2,
        }}
      />
    </View>
  );
}

/**
 * Native "Move stock" — parity for the web StockTransferDialog + Staging
 * put-away. Reads the item's holdings and candidate racks/crates straight from
 * Supabase (RLS-scoped, like the rest of the item screen); the WRITE goes
 * through transferStock() → POST /api/v1/items/<id>/transfer, which enforces the
 * 'stock:transfer' permission server-side.
 *
 * TWO MODES, and they ask different questions:
 *
 *  • FREE-FORM TRANSFER (no `putAwaySourceLocationId`) — the item screen's
 *    "Move stock". The source list includes placed racks AND the
 *    staging/unplaced buckets; choosing which pile to move IS the point, so the
 *    FROM chips are rendered and every warehouse's racks are offered.
 *  • PUT-AWAY (`putAwaySourceLocationId` given) — the Staging worklist's Place.
 *    The source is FIXED to the tapped row: no FROM chips exist in this mode,
 *    exactly like the web dialog
 *    (apps/web/src/components/inventory/place-from-staging-dialog.tsx), which
 *    has no source picker at all. That is why web cannot express a
 *    cross-warehouse put-away and needs no scoping rules — and now neither does
 *    the phone. The destination scope is still applied, but it is DERIVED from
 *    the fixed holding (defence in depth), not from a warehouse the caller
 *    remembered alongside it.
 *
 * The destination is either an existing rack/crate OR one created inline via
 * "+ New rack…" (gated on canCreateLocation; the server asserts
 * 'locations:manage' and creates it in the source location's warehouse).
 *
 * The mode rules live in src/lib/move-stock-form.ts, which is where they can be
 * tested — apps/mobile has no component-test harness.
 */
export function MoveStockModal({
  visible,
  itemId,
  itemName,
  itemType,
  organizationId,
  canCreateLocation,
  putAwaySourceLocationId,
  onClose,
  onMoved,
}: {
  visible: boolean;
  itemId: string;
  itemName: string;
  itemType: string | null;
  organizationId: string;
  canCreateLocation: boolean;
  /**
   * Put-away mode: FIX the source to this holding — the worklist row the user
   * tapped Place on. Not a preselection. In this mode no FROM picker is
   * rendered, the quantity opens at the whole holding, and destinations are
   * scoped to this holding's own warehouse.
   *
   * An item can hold stock in several locations at once, so a preselection that
   * the user could then change was still expressible as "move a different pile,
   * into this pile's building". Fixing it deletes that move rather than guarding
   * against it. If the holding is gone by the time the sheet opens, the sheet
   * says so — it never substitutes another holding.
   *
   * Omitted (the item screen's free-form "Move stock") keeps the source picker
   * and every warehouse's racks, unchanged.
   */
  putAwaySourceLocationId?: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { c, mode } = useTheme();
  const [loading, setLoading] = React.useState(true);
  const [holdings, setHoldings] = React.useState<Holding[]>([]);
  const [destinations, setDestinations] = React.useState<MoveDestination[]>([]);
  const [source, setSource] = React.useState<MoveSource | null>(null);
  // The FREE-FORM mode's picked holding. Deliberately separate from the fixed
  // put-away source below: `fromId` ignores it entirely when the source is
  // fixed, so no setter — and therefore no future chip, gesture or effect — can
  // move a put-away off the tapped row.
  const [chosenFromId, setChosenFromId] = React.useState('');
  const [toId, setToId] = React.useState('');
  const [qty, setQty] = React.useState('1');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Inline "+ New rack" fields — only used when toId === NEW_RACK.
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setQty('1');
    setNotes('');
    setToId('');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setSource(null);
    setChosenFromId('');
    void (async () => {
      // Source holdings: every location this item has stock in (placed racks +
      // staging/unplaced). location_id → qty, with the location's name, kind
      // and warehouse (the warehouse is what the put-away scope is derived
      // FROM, so it must come off the holding row itself).
      const holdingsRes = await supabase
        .from('item_stock_levels')
        .select('location_id, quantity, locations!inner(id, name, kind, warehouse_id)')
        .eq('organization_id', organizationId)
        .eq('item_id', itemId)
        .gt('quantity', 0);
      if (cancelled) return;

      const hs: Holding[] = ((holdingsRes.data ?? []) as unknown[])
        .map((r) => {
          const row = r as {
            location_id: string;
            quantity: number | string;
            locations:
              | { name?: string; kind?: string | null; warehouse_id?: string | null }
              | { name?: string; kind?: string | null; warehouse_id?: string | null }[];
          };
          const loc = Array.isArray(row.locations) ? row.locations[0] : row.locations;
          return {
            locationId: row.location_id,
            name: loc?.name ?? 'Location',
            kind: loc?.kind ?? null,
            quantity: Number(row.quantity) || 0,
            warehouseId: typeof loc?.warehouse_id === 'string' ? loc.warehouse_id : null,
          };
        })
        .filter((h) => h.quantity > 0);

      // Exact-match-or-refuse in put-away mode; first holding in free-form mode.
      const resolved = resolveMoveSource(hs, { putAwaySourceLocationId });
      const scope = moveDestinationScope(resolved);

      // Destination candidates: real placement locations (racks/crates), never
      // the staging/unplaced system buckets. The server re-checks this.
      //
      // Narrowed at the QUERY to the scope the resolved source implies, so the
      // phone never even holds an out-of-warehouse rack; moveDestinationChoices()
      // re-applies the same scope at render, so a future change to this query
      // cannot silently widen the picker.
      let ds: MoveDestination[] = [];
      if (scope.kind !== 'none') {
        let destQuery = supabase
          .from('locations')
          .select('id, name, kind, warehouse_id')
          .eq('organization_id', organizationId)
          .is('deleted_at', null)
          .in('kind', ['rack', 'crate']);
        if (scope.kind === 'warehouse') {
          destQuery = destQuery.eq('warehouse_id', scope.warehouseId);
        }
        const destRes = await destQuery.order('name', { ascending: true });
        if (cancelled) return;
        ds = ((destRes.data ?? []) as Record<string, unknown>[]).map((d) => ({
          id: String(d.id),
          name: typeof d.name === 'string' ? d.name : 'Location',
          kind: typeof d.kind === 'string' ? d.kind : null,
          warehouseId: typeof d.warehouse_id === 'string' ? d.warehouse_id : null,
        }));
      }

      setHoldings(hs);
      setDestinations(ds);
      setSource(resolved);
      setChosenFromId(resolved.mode === 'choice' ? (resolved.holding?.locationId ?? '') : '');
      // Web parity: the put-away dialog opens with the whole staged holding
      // already in the field. Seeding 1 here is what stranded stock. The
      // resolution is the subject, so an unrelated holding's quantity cannot be
      // what lands in the box.
      setQty(initialMoveQuantityForSource(resolved));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, itemId, organizationId, putAwaySourceLocationId]);

  // The FIXED put-away source, if any. When it is set, `fromId` is read off it
  // and `chosenFromId` is not consulted at all — the cross-warehouse put-away is
  // not blocked here, it has no expression.
  const fixedSource = source?.mode === 'fixed' ? source.holding : null;
  const sourceMissing = source?.mode === 'missing';
  const fromId = fixedSource ? fixedSource.locationId : chosenFromId;

  const selected = fixedSource ?? holdings.find((h) => h.locationId === fromId) ?? null;
  const maxQty = selected?.quantity ?? 0;
  const isPutAway = selected?.kind === 'staging' || selected?.kind === 'unplaced';
  const qtyNum = parseInt(qty, 10);
  const qtyValid = !Number.isNaN(qtyNum) && qtyNum > 0 && qtyNum <= maxQty;

  const isBook = itemType === 'book';
  const isNewRack = toId === NEW_RACK;
  // A destination is chosen when an existing rack is picked, or "+ New rack" is
  // selected AND a rack number has been typed.
  const destChosen = isNewRack ? rackNumber.trim().length > 0 : !!toId;
  const canSubmit = !!fromId && destChosen && qtyValid && !submitting;

  // Existing destinations exclude the chosen source rack (can't move to itself)
  // and, for put-away, anything outside the FIXED source holding's warehouse.
  const destChoices = moveDestinationChoices(destinations, {
    excludeLocationId: fromId,
    scope: source ? moveDestinationScope(source) : { kind: 'none' },
  });

  function holdingLabel(h: Holding): string {
    if (h.kind === 'staging') return `Staging · ${h.quantity}`;
    if (h.kind === 'unplaced') return `Unplaced · ${h.quantity}`;
    return `${h.name} · ${h.quantity}`;
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const destination = isNewRack
        ? {
            newRack: {
              rackNumber: rackNumber.trim(),
              ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
              ...(isBook && crateColor.trim() ? { crateColor: crateColor.trim() } : {}),
              ...(isBook && crateNumber.trim() ? { crateNumber: crateNumber.trim() } : {}),
            },
          }
        : { toLocationId: toId };
      await transferStock(itemId, {
        fromLocationId: fromId,
        quantity: qtyNum,
        notes: notes.trim() || undefined,
        ...destination,
      });
      onMoved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not move stock.';
      setError(msg);
      Alert.alert('Could not move stock', msg);
    } finally {
      setSubmitting(false);
    }
  }

  function Chip({
    label,
    active,
    onPress,
  }: {
    label: string;
    active: boolean;
    onPress: () => void;
  }) {
    return (
      <Pressable
        onPress={onPress}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: active ? c.ink : c.hair,
          backgroundColor: active ? c.ink : c.paper2,
        }}
      >
        <Mono size={12.5} color={active ? c.card : c.ink}>
          {label}
        </Mono>
      </Pressable>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              {
                backgroundColor: c.card,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingTop: 12,
                paddingBottom: 36,
                paddingHorizontal: 22,
                maxHeight: '88%',
              },
              SHADOW.sheet,
            ]}
          >
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor:
                    mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                }}
              />
            </View>

            <Eyebrow>{isPutAway ? 'PUT AWAY' : 'MOVE STOCK'}</Eyebrow>
            <Display size={24} style={{ marginTop: 10 }}>
              {itemName}
            </Display>

            {loading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={c.ink4} />
              </View>
            ) : sourceMissing ? (
              // The tapped worklist row is gone — someone else placed it, or it
              // was consumed. That is a REFRESH, not a different move: silently
              // falling back to another of this item's holdings is what armed a
              // one-tap whole-holding move of an unrelated pile.
              <Mono size={13} color={c.ink4} style={{ marginTop: 18, lineHeight: 20 }}>
                This stock is no longer in that location — someone may have already placed
                it. Close this and pull down to refresh the worklist.
              </Mono>
            ) : fixedSource && !fixedSource.warehouseId ? (
              // Same refusal, same words, as the web table's disabled Place.
              <Mono size={13} color={c.ink4} style={{ marginTop: 18, lineHeight: 20 }}>
                No warehouse — cannot place. This holding is not attached to a warehouse, so
                there is no rack it belongs in.
              </Mono>
            ) : holdings.length === 0 ? (
              <Mono size={13} color={c.ink4} style={{ marginTop: 18, lineHeight: 20 }}>
                This item has no stock in any location yet — receive or add stock first.
              </Mono>
            ) : destChoices.length === 0 && !canCreateLocation ? (
              <Mono size={13} color={c.ink4} style={{ marginTop: 18, lineHeight: 20 }}>
                No racks or crates to move into, and you don&apos;t have permission to create one.
                Ask an admin, or create a rack on the web.
              </Mono>
            ) : (
              <ScrollView
                style={{ marginTop: 18 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={{ gap: 6, marginBottom: 16 }}>
                  <Mono size={10} tracking={0.12} upper color={c.ink4}>
                    FROM
                  </Mono>
                  {fixedSource ? (
                    // Put-away: the source is the row the user tapped, rendered
                    // as a READ-ONLY field — the same shape as the web dialog's
                    // disabled "From" box. There are no chips here on purpose:
                    // a picker would make a cross-warehouse move expressible
                    // again, which is the whole reason this mode exists.
                    <View
                      style={{
                        height: 46,
                        justifyContent: 'center',
                        paddingHorizontal: 12,
                        borderWidth: 1,
                        borderColor: c.hair,
                        borderRadius: 8,
                        backgroundColor: c.paper2,
                      }}
                    >
                      <Mono size={12.5} color={c.ink2}>
                        {holdingLabel(fixedSource)}
                      </Mono>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {holdings.map((h) => (
                        <Chip
                          key={h.locationId}
                          label={holdingLabel(h)}
                          active={h.locationId === fromId}
                          onPress={() => {
                            setChosenFromId(h.locationId);
                            // Free-form transfer: re-seed against the newly
                            // chosen holding (always 1 — the whole-holding
                            // default belongs to put-away, which has no chips).
                            setQty(initialMoveQuantity(h.quantity, { wholeHolding: false }));
                            if (toId === h.locationId) setToId('');
                          }}
                        />
                      ))}
                    </View>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <Mono size={10} tracking={0.12} upper color={c.ink4}>
                    TO RACK / CRATE
                  </Mono>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {destChoices.map((d) => (
                      <Chip
                        key={d.id}
                        label={d.name}
                        active={d.id === toId}
                        onPress={() => setToId(d.id)}
                      />
                    ))}
                    {canCreateLocation ? (
                      <Chip
                        label="+ New rack…"
                        active={isNewRack}
                        onPress={() => setToId(NEW_RACK)}
                      />
                    ) : null}
                  </View>

                  {isNewRack ? (
                    <View
                      style={{
                        gap: 10,
                        marginTop: 6,
                        borderWidth: 1,
                        borderColor: c.hair,
                        borderRadius: 10,
                        padding: 12,
                      }}
                    >
                      <RackField
                        label="RACK NUMBER *"
                        value={rackNumber}
                        onChangeText={setRackNumber}
                        placeholder="e.g. A1"
                        c={c}
                      />
                      <RackField
                        label="ROW (OPTIONAL)"
                        value={rackRow}
                        onChangeText={setRackRow}
                        placeholder="e.g. Row 3"
                        c={c}
                      />
                      {isBook ? (
                        <>
                          <RackField
                            label="CRATE COLOR (OPTIONAL)"
                            value={crateColor}
                            onChangeText={setCrateColor}
                            placeholder="e.g. Blue"
                            c={c}
                          />
                          <RackField
                            label="CRATE NUMBER (OPTIONAL)"
                            value={crateNumber}
                            onChangeText={setCrateNumber}
                            placeholder="e.g. 42"
                            c={c}
                          />
                        </>
                      ) : null}
                    </View>
                  ) : null}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                    }}
                  >
                    <Mono size={10} tracking={0.12} upper color={c.ink4}>
                      QUANTITY
                    </Mono>
                    <Mono size={10.5} color={c.ink4}>
                      {maxQty} available
                    </Mono>
                  </View>
                  <TextInput
                    value={qty}
                    onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ''))}
                    placeholder="1"
                    placeholderTextColor={c.ink5}
                    keyboardType="number-pad"
                    style={{
                      fontFamily: FONT.display,
                      fontSize: 18,
                      height: 52,
                      paddingHorizontal: 14,
                      borderWidth: 1,
                      borderColor: !Number.isNaN(qtyNum) && qtyNum > maxQty ? ACCENT.crit : c.hair,
                      borderRadius: 8,
                      color: c.ink,
                      backgroundColor: c.paper2,
                    }}
                  />
                  {!Number.isNaN(qtyNum) && qtyNum > maxQty && (
                    <Mono size={11} color={ACCENT.crit}>
                      Only {maxQty} available in the source location.
                    </Mono>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 4 }}>
                  <Mono size={10} tracking={0.12} upper color={c.ink4}>
                    NOTES (OPTIONAL)
                  </Mono>
                  <TextInput
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="Why is this stock moving?"
                    placeholderTextColor={c.ink5}
                    maxLength={2000}
                    style={{
                      fontFamily: FONT.displayRegular,
                      fontSize: 15,
                      height: 50,
                      paddingHorizontal: 14,
                      borderWidth: 1,
                      borderColor: c.hair,
                      borderRadius: 8,
                      color: c.ink,
                      backgroundColor: c.paper2,
                    }}
                  />
                </View>

                {error && (
                  <Mono size={11.5} color={ACCENT.crit} style={{ marginTop: 12 }}>
                    {error}
                  </Mono>
                )}
              </ScrollView>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <View style={{ flex: 1 }}>
                <Button block variant="ghost" onPress={onClose}>
                  Cancel
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button block onPress={submit} disabled={!canSubmit}>
                  {submitting ? 'Moving…' : isPutAway ? 'Put away' : 'Move stock'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
