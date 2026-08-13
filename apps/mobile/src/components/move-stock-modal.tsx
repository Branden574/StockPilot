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
import { Chip } from '@/components/ui/chip';
import { CRATE_COLOR_OPTIONS, selectedCrateColor } from '@/lib/crate-color-options';
import {
  bookCrateRefusal,
  bookRackRefusal,
  crateSyncWarning,
  decideNewRackPlacement,
  placementRefusalAlert,
  rackAcknowledgementField,
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  newLocationFields,
  newLocationReady,
  resolveMoveSource,
  type MoveDestination,
  type MoveHolding,
  type MoveSource,
  type NewLocationKind,
} from '@/lib/move-stock-form';
import { transferStock, type NewRack } from '@/lib/stock-api';
import {
  bookCrateAcknowledgementsMatch,
  bookRackAcknowledgementsMatch,
  toBookCrateAcknowledgement,
  toBookRackAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookRackAcknowledgedChange,
} from '@stockpilot/core';
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
  // Warehouse name for the fixed put-away source — shown verbatim in the
  // new-rack confirmation copy so the phone's words match the web dialog's.
  const [warehouseName, setWarehouseName] = React.useState<string | null>(null);
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
  // Inline "+ New" fields — only used when toId === NEW_RACK. `newKind` is an
  // EXPLICIT choice: rack XOR crate, never inferred from which boxes are
  // filled. See NewRackInput in src/lib/move-stock-form.ts.
  const [newKind, setNewKind] = React.useState<NewLocationKind>('rack');
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- modal reset on open; remount-keying unsafe here because the reset is interleaved with the put-away source/destination resolution (14 state fields seeded by the same effect, some pre-fetch, some post-await) and keying would mean relocating the whole flow into a new inner component
    setLoading(true);
    setError(null);
    setQty('1');
    setNotes('');
    setToId('');
    setNewKind('rack');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setSource(null);
    setChosenFromId('');
    setWarehouseName(null);
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

      // The warehouse name for the confirmation copy — only meaningful under a
      // warehouse scope (put-away), and best-effort: absent, the shared builder
      // simply omits the "in <warehouse>" clause.
      if (scope.kind === 'warehouse') {
        const whRes = await supabase
          .from('warehouses')
          .select('name')
          .eq('id', scope.warehouseId)
          .maybeSingle();
        if (cancelled) return;
        const name = (whRes.data as { name?: string } | null)?.name;
        if (typeof name === 'string') setWarehouseName(name);
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
  // The "+ New" destination as the form currently stands. One object feeds the
  // readiness check, the confirmation label and the payload, so the sheet can
  // no longer confirm one thing and create another.
  const newLocation = React.useMemo(
    () => ({
      kind: isBook ? newKind : ('rack' as NewLocationKind),
      rackNumber,
      rackRow,
      crateColor,
      crateNumber,
    }),
    [isBook, newKind, rackNumber, rackRow, crateColor, crateNumber],
  );
  // A destination is chosen when an existing rack is picked, or "+ New" is
  // selected AND its OWN branch is complete. A crate is identified by its
  // NUMBER, so a number-only crate is now reachable — the gate used to demand
  // a rack number whichever branch you were in, which made it unreachable.
  const destChosen = isNewRack ? newLocationReady(newLocation) : !!toId;
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

  // The actual write. Split out from the gate so the new-rack confirmation and
  // its "Use 10-A instead" alternatives share ONE permission-checked path.
  async function performMove(
    destination: { newRack: NewRack } | { toLocationId: string },
    opts: {
      acknowledged?: BookCrateAcknowledgedChange[];
      acknowledgedRacks?: BookRackAcknowledgedChange[];
    } = {},
  ) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await transferStock(itemId, {
        fromLocationId: fromId,
        quantity: qtyNum,
        notes: notes.trim() || undefined,
        ...destination,
        ...(opts.acknowledged && opts.acknowledged.length > 0
          ? { acknowledgedCrateChanges: opts.acknowledged }
          : {}),
        // NOT spread conditionally like the crate list above — the asymmetry is
        // deliberate and the rule lives in `rackAcknowledgementField`, where a
        // test can see it. The key is sent on EVERY request, even empty, because
        // its presence is how this sheet declares it can be asked a rack
        // question at all; an absent key makes the route take the fail-safe path
        // (keep the rack, report crateSyncRackPreserved) on every single move.
        //
        // The empty first request is not a weak acknowledgement: this sheet
        // holds a render-time snapshot and no live holdings, so it can never
        // tell a full move (which clears the rack pair) from a split (which does
        // not). It must be TOLD of an erasure by the only reader that knows and
        // then echo that reading back — never predict one and pre-acknowledge it.
        ...rackAcknowledgementField(opts.acknowledgedRacks),
      });
      // The stock moved. This says whether the book's CRATE LABEL followed it —
      // silence would make a move that relabelled nothing look identical to one
      // that did, which is the whole reason the summary drifted in the first
      // place. The four cases and their words live in crateSyncWarning(), where
      // they can actually be tested; this only renders the Alert.
      const crateWarning = crateSyncWarning(res, itemName);
      if (crateWarning) {
        Alert.alert(crateWarning.title, crateWarning.message);
      }
      onMoved();
      onClose();
    } catch (e) {
      // The server REFUSES a move that would overwrite a crate a human
      // recorded, and names it. Re-ask here with the server's own reading of
      // the row and retry with an acknowledgement built from THAT payload —
      // never from anything this screen remembered. Asked at most once more: a
      // refusal that survives an acknowledgement matching the server's own
      // labels is a real error, not a staleness loop.
      //
      // TWO QUESTIONS, ONE PAYLOAD, ONE ALERT. The crate half and the rack half
      // are separately fingerprinted and can arrive together or alone — a
      // rack-ONLY refusal is the reported defect's own case, where the crate is
      // identical and a hand-typed rack would be erased anyway. A refusal saying
      // ANYTHING the last answer did not cover is re-asked; one that only
      // repeats what was already answered falls through to the plain error
      // rather than looping.
      const detail = bookCrateRefusal(e);
      const rackDetail = bookRackRefusal(e);
      const fresh = detail ? toBookCrateAcknowledgement(detail.items) : [];
      const freshRacks = rackDetail ? toBookRackAcknowledgement(rackDetail.items) : [];
      const unanswered =
        !bookCrateAcknowledgementsMatch(opts.acknowledged, fresh) ||
        !bookRackAcknowledgementsMatch(opts.acknowledgedRacks, freshRacks);
      const ask = placementRefusalAlert({ crate: detail, rack: rackDetail });
      if (ask && unanswered) {
        // No inline error: this is a QUESTION, not a failure. `finally` clears
        // the in-flight flag, so the sheet is interactive behind the Alert.
        Alert.alert(ask.title, ask.message, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Continue',
            // BOTH answers go back, and both are built from the SERVER's payload
            // — never from anything this screen remembered.
            onPress: () =>
              void performMove(destination, {
                acknowledged: fresh,
                acknowledgedRacks: freshRacks,
              }),
          },
        ]);
        return;
      }
      const msg = e instanceof Error ? e.message : 'Could not move stock.';
      setError(msg);
      Alert.alert('Could not move stock', msg);
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    if (!canSubmit) return;

    // Existing destination: nothing is created, so no confirmation — the common
    // path stays exactly as many taps as before.
    if (!isNewRack) {
      void performMove({ toLocationId: toId });
      return;
    }

    // Built from the branch the user actually chose. The rack branch sends no
    // crate pair; the crate branch sends its number, its optional colour and —
    // when typed — the rack it SITS ON, so the phone can express a positioned
    // crate and the server names the row from the same object the sheet
    // confirmed.
    const newRack = newLocationFields(newLocation) as NewRack;

    // The 2026-07-23 guard: a typed rack/crate that does NOT already exist in
    // this warehouse gets an explicit confirmation before it is minted. The
    // decision (and its copy) come from the shared core builder, so the phone
    // shows the same words as web. An EXISTING label is reused server-side and
    // is not a creation, so it proceeds straight through.
    // Existence must be judged against the warehouse the server will CREATE in
    // — the source holding's own warehouse — not every warehouse the user can
    // read. In free-form move mode the destination list spans all warehouses, so
    // a same-named rack in a DIFFERENT warehouse would otherwise read as
    // "exists", skip the confirmation, and let the server mint a brand-new rack
    // in the source warehouse anyway. (In put-away mode the list is already
    // scoped to that one warehouse, so this filter is a harmless no-op.)
    const sourceWarehouseId = selected?.warehouseId ?? null;
    const existingLabels = destinations
      .filter((d) => sourceWarehouseId == null || d.warehouseId === sourceWarehouseId)
      .map((d) => d.name);
    const decision = decideNewRackPlacement({
      rack: newLocation,
      warehouseName,
      quantity: qtyNum,
      existingLabels,
    });

    if (decision.exists) {
      void performMove({ newRack });
      return;
    }

    // "Did you mean 10-A?" — offer existing near-matches as one tap each (place
    // into that rack, creating nothing), then Cancel and the deliberate create.
    // Android's native AlertDialog renders at most THREE buttons, so with Cancel
    // and Create already taking two, only ONE suggestion fits there; iOS shows
    // them all. The suggestion's rack is resolved within the SOURCE warehouse so
    // a same-named rack elsewhere is never the target.
    const maxSuggestions = Platform.OS === 'android' ? 1 : 2;
    const suggestionButtons = decision.suggestions.slice(0, maxSuggestions).flatMap((label) => {
      const match = destinations.find(
        (d) =>
          (sourceWarehouseId == null || d.warehouseId === sourceWarehouseId) &&
          d.name.trim().toLowerCase() === label.trim().toLowerCase(),
      );
      return match
        ? [{ text: `Use ${label} instead`, onPress: () => void performMove({ toLocationId: match.id }) }]
        : [];
    });

    Alert.alert(decision.title, decision.message, [
      { text: 'Cancel', style: 'cancel' },
      ...suggestionButtons,
      { text: 'Create and put away', onPress: () => void performMove({ newRack }) },
    ]);
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
                        label={isBook ? '+ New rack / crate…' : '+ New rack…'}
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
                      {/* Rack OR crate, asked EXPLICITLY — the KIND of row.
                          The field that decides locations.kind (and therefore
                          migration 0270's kind-scoped dedupe bucket) used to be
                          inferred from whether a colour happened to be typed.
                          It is NOT a choice between two places: a crate SITS ON
                          a rack, so the crate branch keeps the same optional
                          rack fields and "rack A1 + crate 9" creates crate 9 AT
                          rack A1 — one row, named for both. */}
                      {isBook ? (
                        <View style={{ gap: 6 }}>
                          <Mono size={10} tracking={0.12} upper color={c.ink4}>
                            NEW LOCATION TYPE
                          </Mono>
                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            <Chip
                              label="Rack"
                              active={newKind === 'rack'}
                              onPress={() => setNewKind('rack')}
                            />
                            <Chip
                              label="Crate"
                              active={newKind === 'crate'}
                              onPress={() => setNewKind('crate')}
                            />
                          </View>
                        </View>
                      ) : null}

                      {!isBook || newKind === 'rack' ? (
                        <>
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
                        </>
                      ) : (
                        <>
                          {/* CRATE COLOUR — a FIXED choice over the shared
                              registry, not free text.
                              This was a text box ("e.g. Blue") long after the
                              web put-away dialogs had been narrowed to the same
                              ten colours, so the phone was the one surface that
                              could still mint a colour the registry has never
                              heard of — stored verbatim, then rendered with no
                              swatch and filtered as a colour of its own.
                              "No color" leads the row because a crate is
                              identified by its NUMBER: production holds crates
                              numbered with no colour at all, and that has to
                              stay expressible from here. */}
                          <View style={{ gap: 6 }}>
                            <Mono size={10} tracking={0.12} upper color={c.ink4}>
                              CRATE COLOR (OPTIONAL)
                            </Mono>
                            <View
                              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
                              accessibilityRole="radiogroup"
                              accessibilityLabel="Crate color"
                            >
                              {CRATE_COLOR_OPTIONS.map((opt) => (
                                <Chip
                                  key={opt.label}
                                  label={opt.label}
                                  swatch={opt.hex}
                                  active={selectedCrateColor(crateColor) === opt.value}
                                  onPress={() => setCrateColor(opt.value)}
                                />
                              ))}
                            </View>
                          </View>
                          {/* The NUMBER is the crate's identity — staff
                              routinely number a crate before they know which
                              coloured bin it lands in. */}
                          <RackField
                            label="CRATE NUMBER *"
                            value={crateNumber}
                            onChangeText={setCrateNumber}
                            placeholder="e.g. 42"
                            c={c}
                          />
                          {/* WHERE THE CRATE SITS. Optional — a crate on no
                              rack is a real, permanent shape — but when it is
                              given it is part of the crate's IDENTITY, not
                              decoration: crate "BIN" names five different bins
                              in this warehouse, and only the rack tells them
                              apart. */}
                          <Mono size={10.5} color={c.ink4} style={{ lineHeight: 15 }}>
                            A crate sits on a rack. Say which one and the book is recorded in both.
                          </Mono>
                          <RackField
                            label="ON RACK (OPTIONAL)"
                            value={rackNumber}
                            onChangeText={setRackNumber}
                            placeholder="e.g. 38"
                            c={c}
                          />
                          <RackField
                            label="ROW (OPTIONAL)"
                            value={rackRow}
                            onChangeText={setRackRow}
                            placeholder="e.g. B"
                            c={c}
                          />
                        </>
                      )}
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
