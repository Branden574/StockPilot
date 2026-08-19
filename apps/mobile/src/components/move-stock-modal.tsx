import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Display, Eyebrow, Mono } from '@/components/ui/text';
import { Chip } from '@/components/ui/chip';
import { CRATE_COLOR_OPTIONS, selectedCrateColor } from '@/lib/crate-color-options';
import {
  bookCrateRefusal,
  bookDestination,
  bookDestinationIsRecordedStorage,
  bookDestinationNeedsMint,
  bookRackRefusal,
  crateSyncWarning,
  decideNewRackPlacement,
  EMPTY_DESTINATION_FIELDS,
  fieldsFromDestination,
  placementRefusalAlert,
  transferRequestBody,
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  newLocationFields,
  newLocationProblem,
  newLocationReady,
  newRackLabel,
  resolveMoveSource,
  seedDestinationFromStorage,
  type DestinationFields,
  type MoveDestination,
  type MoveHolding,
  type MoveSource,
  type NewLocationKind,
  type NewRackInput,
} from '@/lib/move-stock-form';
import { transferStock, type NewRack } from '@/lib/stock-api';
import {
  bookCrateAcknowledgementsMatch,
  bookRackAcknowledgementsMatch,
  readBookStorage,
  toBookCrateAcknowledgement,
  toBookRackAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookRackAcknowledgedChange,
  type BookStorageInfo,
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
 * "+ New rack…" / the book's four fields (gated on canCreateLocation — the
 * phone's copy of the placement gate, `canMintPlacementDestination`; the
 * server creates it in the source location's warehouse under 'stock:transfer'
 * or 'locations:manage', through the placement path only — 0340, D1).
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
  bookStorage,
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
   * A BOOK's recorded rack/crate summary, when the caller already has it (the
   * staging worklist does — GET /api/v1/inventory/staging sends it per row).
   * It SEEDS the four destination fields, so the default destination is the
   * crate the book already records, on the rack it records (Maus I,
   * 2026-08-17: the sheet used to offer only existing chips, and for a
   * label-only crate the reachable choice was the bare rack, which clears the
   * crate). `undefined` = "not known here": the sheet reads the item's own
   * custom_fields once on open (RLS, like its holdings read). `null` = a
   * non-book or nothing recorded.
   */
  bookStorage?: BookStorageInfo | null;
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
  // ═══ THE FOUR FIELDS ARE THE DESTINATION (books) — Maus I, 2026-08-17 ═══
  // For a BOOK: rack number, row, crate colour, crate number — always visible,
  // SEEDED from the recorded storage, FILLED by tapping an existing chip. The
  // planner decides the kind from what is filled in (any crate box → a crate
  // ON the typed rack; crate blank → the bare rack). No Rack|Crate chip pair
  // and no "+ New" chip for a book: the fields ARE the destination, and the
  // server resolves-or-creates the row by name. NON-BOOKS keep the older shape
  // ("+ New rack…" chip → the rack pair). Decisions live in
  // src/lib/move-stock-form.ts where they are tested.
  const [fields, setFields] = React.useState<DestinationFields>(EMPTY_DESTINATION_FIELDS);
  const { rackNumber, rackRow, crateColor, crateNumber } = fields;
  const setField = (key: keyof DestinationFields) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));
  /** A recorded crate colour the chip row cannot show (not in CRATE_COLORS). */
  const [unknownCrateColor, setUnknownCrateColor] = React.useState<string | null>(null);
  /** The storage the fields were seeded from — the prop, or the on-open read. */
  const [storage, setStorage] = React.useState<BookStorageInfo | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- modal reset on open; remount-keying unsafe here because the reset is interleaved with the put-away source/destination resolution (14 state fields seeded by the same effect, some pre-fetch, some post-await) and keying would mean relocating the whole flow into a new inner component
    setLoading(true);
    setError(null);
    setQty('1');
    setNotes('');
    setToId('');
    setFields(EMPTY_DESTINATION_FIELDS);
    setUnknownCrateColor(null);
    setStorage(null);
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

      // Destination candidates: real placement locations (racks/crates), plus
      // the per-warehouse Unplaced bucket IN FREE-FORM MODE ONLY. Never
      // Staging. The server allows exactly this pair (see the note in POST
      // /api/v1/items/[id]/transfer).
      //
      // ═══ WHY UNPLACED IS HERE, AND WHY NOT IN PUT-AWAY ═══
      //
      // Unplaced was filtered out everywhere until rack 100-A. With no way to
      // say "off the rack, still on hand", the only way to clear a rack that
      // should not exist was the write-off — and on 2026-07-23 that cost 220
      // real books. Free-form Move, reached from the item screen, is exactly
      // where that repair happens, so it offers Unplaced.
      //
      // PUT-AWAY DOES NOT. It is reached from the Staging worklist's Place with
      // a FIXED source, and its whole contract is that the stock lands on a
      // placement; letting Place resolve to "no rack" would drain the worklist
      // without shelving anything, which is a different bug from the one being
      // fixed. `putAwaySourceLocationId` is the mode signal — it is only ever
      // set by that worklist.
      //
      // Staging is out of both: stock arriving there reads as an unprocessed
      // receipt.
      const destinationKinds = putAwaySourceLocationId
        ? ['rack', 'crate']
        : ['rack', 'crate', 'unplaced'];
      //
      // Narrowed at the QUERY to the scope the resolved source implies, so the
      // phone never even holds an out-of-warehouse rack; moveDestinationChoices()
      // re-applies the same scope at render, so a future change to this query
      // cannot silently widen the picker.
      let ds: MoveDestination[] = [];
      if (scope.kind !== 'none') {
        // The row's own rack/crate columns (0188) travel too, so tapping a chip
        // can FILL a book's four destination fields rather than only name a row.
        let destQuery = supabase
          .from('locations')
          .select('id, name, kind, warehouse_id, rack_number, rack_row, crate_color, crate_number')
          .eq('organization_id', organizationId)
          .is('deleted_at', null)
          .in('kind', destinationKinds);
        if (scope.kind === 'warehouse') {
          destQuery = destQuery.eq('warehouse_id', scope.warehouseId);
        }
        const destRes = await destQuery.order('name', { ascending: true });
        if (cancelled) return;
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        ds = ((destRes.data ?? []) as Record<string, unknown>[]).map((d) => ({
          id: String(d.id),
          name: typeof d.name === 'string' ? d.name : 'Location',
          kind: typeof d.kind === 'string' ? d.kind : null,
          warehouseId: str(d.warehouse_id),
          rackNumber: str(d.rack_number),
          rackRow: str(d.rack_row),
          crateColor: str(d.crate_color),
          crateNumber: str(d.crate_number),
        }));
        // Unplaced FIRST, not buried at "U" in a 48-rack alphabetical list —
        // the whole point is that the non-destructive way off a rack is the
        // easy one to reach.
        ds = [...ds.filter((d) => d.kind === 'unplaced'), ...ds.filter((d) => d.kind !== 'unplaced')];
      }

      // The BOOK's recorded storage — the seed for the four fields. The
      // staging worklist hands it in; the item screen does not, so read the
      // row once here (RLS, like the holdings read above). A non-book seeds
      // nothing and reads nothing.
      let recorded: BookStorageInfo | null = null;
      if (itemType === 'book') {
        if (bookStorage !== undefined) {
          recorded = bookStorage;
        } else {
          const itemRes = await supabase
            .from('inventory_items')
            .select('custom_fields')
            .eq('organization_id', organizationId)
            .eq('id', itemId)
            .maybeSingle();
          if (cancelled) return;
          const cf = (itemRes.data as { custom_fields?: Record<string, unknown> | null } | null)
            ?.custom_fields;
          recorded = readBookStorage(cf ?? null);
        }
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
      setStorage(recorded);
      const seeded = seedDestinationFromStorage(recorded);
      setFields(seeded.fields);
      setUnknownCrateColor(seeded.unknownCrateColor);
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
    // `bookStorage` and `itemType` are read inside; a caller re-rendering with a
    // fresh object must not re-run the whole open sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const isNewRack = !isBook && toId === NEW_RACK;

  // Existing destinations exclude the chosen source rack (can't move to itself)
  // and, for put-away, anything outside the FIXED source holding's warehouse.
  const destChoices = moveDestinationChoices(destinations, {
    excludeLocationId: fromId,
    scope: source ? moveDestinationScope(source) : { kind: 'none' },
  });
  const selectedChip = isBook ? (destChoices.find((d) => d.id === toId) ?? null) : null;
  // Derived from what is ACTUALLY on screen, not from the mode, so the heading
  // can never promise a chip the list does not contain (or omit one it does).
  // Put-away has no Unplaced chip and keeps the old wording; free-form has one
  // and must say so — an operator looking for the safe way off a rack should
  // find it named in the heading, not only in a chip.
  const offersUnplaced = destChoices.some((d) => d.kind === 'unplaced');

  // ═══ WHAT THE FOUR BOXES DESCRIBE (books) ═══
  // The chip by id while the boxes still equal its columns; otherwise a crate
  // on the typed position or a bare rack, described by fields and
  // resolved-or-created by name on the server.
  const bookDest = React.useMemo(
    () => (isBook ? bookDestination(fields, selectedChip) : null),
    [isBook, fields, selectedChip],
  );
  // The NON-BOOK "+ New rack…" destination as the form currently stands.
  const newLocation = React.useMemo<NewRackInput>(
    () => ({ kind: 'rack' as NewLocationKind, rackNumber, rackRow }),
    [rackNumber, rackRow],
  );
  // The place the fields name, if it would have to be CREATED. Existence is
  // judged in the SOURCE warehouse, the one the server creates in.
  const sourceWarehouseId = selected?.warehouseId ?? null;
  const existingLabels = React.useMemo(
    () =>
      destinations
        .filter((d) => sourceWarehouseId == null || d.warehouseId === sourceWarehouseId)
        .map((d) => d.name),
    [destinations, sourceWarehouseId],
  );
  const bookNeedsMint = bookDest !== null && bookDestinationNeedsMint(bookDest, existingLabels);
  const cannotMint = isBook && bookNeedsMint && !canCreateLocation;
  // A move INTO the place the stock is already in is a no-op the server
  // refuses. For a book whose fields were seeded from the crate it is being
  // moved OUT of (free-form transfer), that is the opening state — say so.
  const sameAsSource =
    isBook &&
    bookDest !== null &&
    bookDest.mode === 'new' &&
    !!selected &&
    newRackLabel(bookDest.input).label.toLowerCase() === selected.name.trim().toLowerCase();
  // The planner's own refusal for a half-filled form, in its words — or, when
  // the fields are fine but the row would need creating by someone who may
  // not, that.
  const bookProblem =
    isBook && bookDest !== null && bookDest.mode === 'new'
      ? (newLocationProblem(bookDest.input) ??
        (sameAsSource
          ? 'That is where this stock already is — pick a different destination.'
          : cannotMint
            ? `${newRackLabel(bookDest.input).label} does not exist yet, and placing into a new rack or crate needs the Transfer stock permission. Tap an existing rack or crate, or ask a manager to create it.`
            : null))
      : null;
  // A destination is chosen when: BOOK — the fields name a place the planner
  // can name (a chip is always ready), it is not the source, and this user may
  // create it if needed; NON-BOOK — a chip is picked, or "+ New" is selected
  // AND complete.
  const destChosen = isBook
    ? bookDest !== null &&
      (bookDest.mode === 'existing' || newLocationReady(bookDest.input)) &&
      !cannotMint &&
      !sameAsSource
    : isNewRack
      ? newLocationReady(newLocation)
      : !!toId;
  const canSubmit = !!fromId && destChosen && qtyValid && !submitting;

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
      const res = await transferStock(
        itemId,
        // The body is built by transferRequestBody() in src/lib, where a test
        // can reach it. Its two keys are deliberately asymmetric -- the rack
        // key always present (its presence is how this client declares it can
        // answer a rack question), the crate key only when non-empty (the
        // shape already shipped in the live OTA). Inlining that here is what
        // let the shipped bug survive every test once already.
        transferRequestBody({
          fromLocationId: fromId,
          quantity: qtyNum,
          notes: notes.trim() || undefined,
          destination,
          acknowledged: opts.acknowledged,
          acknowledgedRacks: opts.acknowledgedRacks,
        }),
      );
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

    // ═══ BOOKS: the four fields ARE the destination ═══
    if (isBook && bookDest) {
      if (bookDest.mode === 'existing') {
        void performMove({ toLocationId: bookDest.destination.id });
        return;
      }
      const newRack = newLocationFields(bookDest.input) as NewRack;
      // The recorded truth being minted as a row for the first time is not a
      // typo to guard against — no "Create new crate …?" on the default path.
      // The server resolves an existing row by name and mints once otherwise.
      if (bookDestinationIsRecordedStorage(bookDest, storage)) {
        void performMove({ newRack });
        return;
      }
      confirmCreationThenMove(bookDest.input, newRack);
      return;
    }

    // Existing destination: nothing is created, so no confirmation — the common
    // path stays exactly as many taps as before.
    if (!isNewRack) {
      void performMove({ toLocationId: toId });
      return;
    }

    // NON-BOOK "+ New rack…": the rack pair, and nothing else.
    confirmCreationThenMove(newLocation, newLocationFields(newLocation) as NewRack);
  }

  /**
   * The 2026-07-23 guard: a typed rack/crate that does NOT already exist in
   * the source warehouse gets an explicit confirmation before it is minted.
   */
  function confirmCreationThenMove(input: NewRackInput, newRack: NewRack) {

    // The decision (and its copy) come from the shared core builder, so the
    // phone shows the same words as web. An EXISTING label is reused
    // server-side and is not a creation, so it proceeds straight through.
    // Existence is judged against the warehouse the server will CREATE in — the
    // source holding's own warehouse — not every warehouse the user can read.
    // In free-form move mode the destination list spans all warehouses, so a
    // same-named rack in a DIFFERENT warehouse would otherwise read as
    // "exists", skip the confirmation, and let the server mint a brand-new rack
    // in the source warehouse anyway. (In put-away mode the list is already
    // scoped to that one warehouse, so this filter is a harmless no-op.)
    const decision = decideNewRackPlacement({
      rack: input,
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
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
         * ancestor claims the touch on press-down and beats the ScrollView's
         * pan recogniser, so the modal body would not scroll until something
         * else took the responder first (focusing a text field). Do not
         * re-nest this card inside the scrim — taps outside still close
         * because the scrim fills the screen behind it. See
         * add-order-items-sheet.tsx for the measured detail.
         */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={onClose}
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
              },
            ]}
          />
          <View
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
                    {offersUnplaced
                      ? isBook
                        ? 'TO RACK, CRATE, OR UNPLACED — TAP TO FILL IN'
                        : 'TO RACK, CRATE, OR UNPLACED'
                      : isBook
                        ? 'TO RACK / CRATE — TAP TO FILL IN'
                        : 'TO RACK / CRATE'}
                  </Mono>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {destChoices.map((d) => (
                      <Chip
                        key={d.id}
                        label={d.name}
                        // For a BOOK a chip is a shortcut that FILLS the four
                        // fields; it stays lit only while the fields still
                        // equal it (bookDest resolves to it by id).
                        active={
                          isBook
                            ? bookDest?.mode === 'existing' && bookDest.destination.id === d.id
                            : d.id === toId
                        }
                        onPress={() => {
                          setToId(d.id);
                          if (isBook) {
                            setFields(fieldsFromDestination(d));
                            setUnknownCrateColor(null);
                          }
                        }}
                      />
                    ))}
                    {!isBook && canCreateLocation ? (
                      <Chip
                        label="+ New rack…"
                        active={isNewRack}
                        onPress={() => setToId(NEW_RACK)}
                      />
                    ) : null}
                  </View>

                  {isBook ? (
                    /* ═══ THE FOUR FIELDS, ALWAYS VISIBLE — the book put-away's
                       primary input. Seeded from the recorded storage, filled
                       by a chip, and the planner decides the kind from what
                       is filled in. A crate SITS ON a rack, so both facts are
                       on screen at once. Blank the crate to place on the bare
                       rack — the crate label is then cleared, and the gate
                       asks first. ═══ */
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
                      <Mono size={10} tracking={0.12} upper color={c.ink4}>
                        PLACE INTO
                      </Mono>
                      <Mono size={10.5} color={c.ink4} style={{ lineHeight: 15 }}>
                        The rack and, if it sits in one, the crate on that rack. Leave the crate
                        blank to place on the bare rack — the crate label is then cleared, and you
                        will be asked first.
                      </Mono>
                      <RackField
                        label="RACK NUMBER"
                        value={rackNumber}
                        onChangeText={setField('rackNumber')}
                        placeholder="e.g. 38"
                        c={c}
                      />
                      <RackField
                        label="ROW"
                        value={rackRow}
                        onChangeText={setField('rackRow')}
                        placeholder="e.g. B"
                        c={c}
                      />
                      {/* CRATE COLOUR — a FIXED choice over the shared registry
                          (CRATE_COLORS), never free text. "No color" leads the
                          row because a crate is identified by its NUMBER. */}
                      <View style={{ gap: 6 }}>
                        <Mono size={10} tracking={0.12} upper color={c.ink4}>
                          CRATE COLOR
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
                              onPress={() => setField('crateColor')(opt.value)}
                            />
                          ))}
                        </View>
                        {unknownCrateColor ? (
                          <Mono size={10.5} color={c.ink4} style={{ lineHeight: 15 }}>
                            This book’s recorded crate color, “{unknownCrateColor}”, is not one of
                            the crate colors, so it could not be filled in. Pick the nearest one,
                            or leave it blank to record no color.
                          </Mono>
                        ) : null}
                      </View>
                      <RackField
                        label="CRATE NUMBER"
                        value={crateNumber}
                        onChangeText={setField('crateNumber')}
                        placeholder="e.g. 4"
                        c={c}
                      />
                      {bookProblem ? (
                        <Mono size={11} color={ACCENT.crit} style={{ lineHeight: 15 }}>
                          {bookProblem}
                        </Mono>
                      ) : null}
                    </View>
                  ) : isNewRack ? (
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
                        onChangeText={setField('rackNumber')}
                        placeholder="e.g. A1"
                        c={c}
                      />
                      <RackField
                        label="ROW (OPTIONAL)"
                        value={rackRow}
                        onChangeText={setField('rackRow')}
                        placeholder="e.g. Row 3"
                        c={c}
                      />
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
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
