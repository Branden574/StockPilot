import { useRouter } from 'expo-router';
import {
  Calendar,
  ChevronLeft,
  Minus,
  PackageOpen,
  Plus,
  Search,
  User,
  UserCheck,
  Warehouse,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  RENTAL_BORROWER_EMAIL_HELP,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_NO_EMAIL_NOTE,
  stockAvailability,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { showWriteCta } from '@/lib/cta-gating';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { readErrorMessage, settleIdBatchRead } from '@/lib/id-batches';
import { readOpenReservations, sumReservedByItem } from '@/lib/id-reads';
import {
  BORROWER_EMAIL_FORMAT_ERROR,
  EMPTY_BORROWER,
  borrowerEmailInvalid,
  borrowerRequestFields,
  borrowerSearchFailure,
  keepPickedMember,
  listRentalBorrowers,
  matchBorrowers,
  pickMember,
  someoneElse,
  typeEmail,
  typeName,
  type BorrowerDraft,
  type BorrowerSearch,
  type RentalBorrowerMember,
} from '@/lib/rental-borrower';
import { rentalPickerStatus } from '@/lib/rental-items';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface WarehouseRow {
  id: string;
  name: string;
}

interface RentalItemRow {
  id: string;
  name: string | null;
  sku: string | null;
  quantity_on_hand: number | null;
}

/**
 * Mobile rental checkout. Picks rental items in the selected warehouse and
 * POSTs the whole checkout to the Bearer twin at /api/v1/rentals, which runs
 * RentalsService.create — the SAME service the web server action calls.
 *
 * READ THIS BEFORE CHANGING IT (SP-012). This screen used to
 * `supabase.from('rentals').insert(...)` a header row straight into the table.
 * RLS 0131 accepts that row — its only gate is
 * `user_can_access_warehouse(auth.uid(), warehouse_id, 'write')` — so it always
 * looked like it worked, while eight things the service does never ran:
 *   • `rentals:create` was never asserted (RLS does not know about the
 *     configurable permissions at all),
 *   • non-rental items / wrong-warehouse items were never refused,
 *   • over-lending was never refused (SP-052 availability = on hand − open
 *     reservations),
 *   • NO `rental_lines` were written, so the rental carried no inventory
 *     linkage — and there is no add-line path anywhere to attach items later,
 *   • NO `stock_reservations` were written, which a device CANNOT do: that
 *     table is service-role only (migs 0119/0263). The checked-out asset stayed
 *     fully available-to-promise and could be rented again from the web to a
 *     second borrower,
 *   • no audit row, no checkout email, no borrower_user_id for members.
 * The parity rule in this repo is that mobile WRITES go through /api/v1, never
 * straight to a table, precisely so a screen cannot re-implement half a service
 * by accident. Do not reintroduce a direct write here — apps/mobile/src/lib/
 * rental-checkout-wiring.test.ts pins that.
 *
 * CONSEQUENCE OF THE FIX, ON PURPOSE: a checkout can now FAIL where it used to
 * always succeed (nothing rentable available, an item that is not is_rental, a
 * warehouse mismatch). Those refusals carry the service's own operator-readable
 * sentence and are shown verbatim — never swallowed.
 */
export default function NewRental() {
  const router = useRouter();
  const { user } = useAuth();
  const { orgId } = useOrg();
  const { c } = useTheme();
  // The rentals list already hides its '+' for members without rentals:create
  // (src/screens/rentals.tsx), but this route is reachable directly. The real
  // gate now lives behind the route (RentalsService asserts the permission), so
  // this check is purely so an honest deep link gets a sentence instead of a
  // 403 round-trip. Client-side, therefore NOT a security boundary
  // (showWriteCta even fails OPEN while the permission set is still loading,
  // matching every other screen).
  const perms = useEffectivePermissions();
  const canCreate = showWriteCta(perms, 'rentals:create');
  const [warehouses, setWarehouses] = React.useState<WarehouseRow[]>([]);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  // The warehouses read has its OWN state and retry trigger. It used to ignore
  // its error, leaving an empty list, which spun the WAREHOUSE section (and,
  // through `!warehouseId`, the ITEMS section) forever. An org with no active
  // warehouse spun forever too.
  const [warehousesLoading, setWarehousesLoading] = React.useState(true);
  const [warehousesError, setWarehousesError] = React.useState<string | null>(null);
  const [warehousesNonce, setWarehousesNonce] = React.useState(0);
  const [items, setItems] = React.useState<RentalItemRow[]>([]);
  const [reservedByItem, setReservedByItem] = React.useState<Record<string, number>>({});
  const [itemsLoading, setItemsLoading] = React.useState(false);
  // Why the items or their open reservations did not load. Either one BLOCKS
  // the picker (rentalPickerStatus): a failed reservations read used to read
  // as "nothing reserved", so every figure showed on hand as available and the
  // + button offered units the server then refused. Cleared by every load.
  const [itemsError, setItemsError] = React.useState<string | null>(null);
  const [stockError, setStockError] = React.useState<string | null>(null);
  const [itemsNonce, setItemsNonce] = React.useState(0);
  const [search, setSearch] = React.useState('');
  /** itemId → quantity. The cart; each entry becomes one `lines[]` element. */
  const [cart, setCart] = React.useState<Record<string, number>>({});
  // The borrower: a picked team member, or anyone else by typed name and
  // email (lib/rental-borrower.ts holds the rules, the web picker's).
  const [borrower, setBorrower] = React.useState<BorrowerDraft>(EMPTY_BORROWER);
  // The team members to search. A failed load never blocks the form: a typed
  // name and email still check out (see borrowerSearchFailure).
  const [borrowerSearch, setBorrowerSearch] = React.useState<BorrowerSearch>({ status: 'loading' });
  const [borrowerNonce, setBorrowerNonce] = React.useState(0);
  const [returnDays, setReturnDays] = React.useState('7');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      setWarehousesLoading(true);
      setWarehousesError(null);
      const { data, error, status } = await supabase
        .from('warehouses')
        .select('id, name')
        .eq('organization_id', orgId)
        .neq('status', 'archived')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (error) {
        console.warn('rental warehouses', error);
        setWarehouses([]);
        setWarehouseId(null);
        setCart({});
        // Never empty: a gateway 502 or 504 with an empty body gives an empty
        // error.message, which would leave the failure with no reason.
        setWarehousesError(readErrorMessage(error, status));
        setWarehousesLoading(false);
        return;
      }
      const list = (data ?? []) as WarehouseRow[];
      setWarehouses(list);
      // A retry keeps the operator's pick when it is still there.
      setWarehouseId((prev) =>
        prev && list.some((w) => w.id === prev) ? prev : (list[0]?.id ?? null),
      );
      setWarehousesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, warehousesNonce]);

  // Team members for the borrower search (GET /api/v1/rentals/borrowers, the
  // web picker's query). Only for someone who may check out: the route answers
  // 403 otherwise, and the screen already says they cannot. Reloaded for a new
  // organization and by Try again.
  React.useEffect(() => {
    if (!orgId || !canCreate) return;
    let cancelled = false;
    void (async () => {
      setBorrowerSearch({ status: 'loading' });
      try {
        const members = await listRentalBorrowers();
        if (cancelled) return;
        setBorrowerSearch({ status: 'ready', members });
        // A member picked before a switch of organization is not this one's.
        setBorrower((d) => keepPickedMember(d, members));
      } catch (e) {
        if (!cancelled) setBorrowerSearch(borrowerSearchFailure(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, canCreate, borrowerNonce]);

  // Rental items for the selected warehouse, plus the OPEN reservations against
  // them. Availability, not on-hand, is what the server enforces (SP-052), so
  // showing on-hand here would offer units the route then refuses — the mirror
  // of the web picker bug where the cart's '+' capped at quantity_on_hand while
  // the card displayed availability.
  React.useEffect(() => {
    if (!orgId || !warehouseId) return;
    let cancelled = false;
    // Both setState calls live INSIDE the async body on purpose: calling
    // setState directly in an effect body cascades a render (and trips
    // react-hooks/set-state-in-effect).
    void (async () => {
      setItemsLoading(true);
      // Every error flag belongs to ONE load: a new load starts clean.
      setItemsError(null);
      setStockError(null);
      // Changing warehouse invalidates the cart: the service refuses any line
      // whose item is not in the rental warehouse, so keeping it would
      // guarantee a refusal the operator cannot see the cause of.
      setCart({});
      const { data, error, status } = await supabase
        .from('inventory_items')
        .select('id, name, sku, quantity_on_hand')
        .eq('organization_id', orgId)
        .eq('warehouse_id', warehouseId)
        .eq('status', 'active')
        .eq('is_rental', true)
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .limit(500);
      if (cancelled) return;
      if (error) {
        // Not "No rental items in this warehouse": that sentence sends the
        // operator to the web to mark items rentable that already are.
        console.warn('rental items', error);
        setItems([]);
        setReservedByItem({});
        setItemsError(readErrorMessage(error, status));
        setItemsLoading(false);
        return;
      }
      const rows = (data ?? []) as RentalItemRow[];
      setItems(rows);

      // Open reservations for up to 500 items, batched (one `.in()` URL with
      // 500 uuids fails). A failure is NOT "nothing reserved": it blocks the
      // picker, since every figure would otherwise show on hand as available.
      const reservations = await settleIdBatchRead(
        readOpenReservations(
          supabase,
          orgId,
          rows.map((r) => r.id),
        ),
      );
      if (cancelled) return;
      if (reservations.ok) {
        setReservedByItem(Object.fromEntries(sumReservedByItem(reservations.value)));
      } else {
        console.warn('rental reservations', reservations.message);
        setReservedByItem({});
        setCart({});
        setStockError(reservations.message);
      }
      setItemsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, warehouseId, itemsNonce]);

  const availableFor = React.useCallback(
    (item: RentalItemRow) =>
      stockAvailability({
        onHand: item.quantity_on_hand ?? 0,
        reserved: reservedByItem[item.id] ?? 0,
      }).available,
    [reservedByItem],
  );

  const visibleItems = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) =>
        (i.name ?? '').toLowerCase().includes(needle) ||
        (i.sku ?? '').toLowerCase().includes(needle),
    );
  }, [items, search]);

  const lines = React.useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([itemId, quantity]) => ({ itemId, quantity })),
    [cart],
  );

  const expectedReturn = React.useMemo(() => {
    const days = parseInt(returnDays, 10);
    if (Number.isNaN(days) || days <= 0) return null;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  }, [returnDays]);

  function addOne(item: RentalItemRow) {
    const max = availableFor(item);
    setCart((prev) => {
      const next = (prev[item.id] ?? 0) + 1;
      // Cap at availability, not on-hand. The server refuses over-lends anyway;
      // this just means the phone never offers a quantity it will be refused for.
      if (next > max) return prev;
      return { ...prev, [item.id]: next };
    });
  }

  function removeOne(item: RentalItemRow) {
    setCart((prev) => {
      const next = (prev[item.id] ?? 0) - 1;
      const copy = { ...prev };
      if (next <= 0) delete copy[item.id];
      else copy[item.id] = next;
      return copy;
    });
  }

  // Blocked while any read the picker is built on has failed (see
  // rentalPickerStatus): the list, its steppers and Check out are withheld.
  const picker = rentalPickerStatus({ warehousesError, itemsError, stockError });

  const canSubmit =
    canCreate &&
    Boolean(orgId) &&
    Boolean(warehouseId) &&
    lines.length > 0 &&
    borrower.name.trim().length > 0 &&
    !borrowerEmailInvalid(borrower) &&
    Boolean(expectedReturn) &&
    !busy &&
    !picker.blocked &&
    !itemsLoading;

  async function submit() {
    if (!orgId || !warehouseId || !user) return;
    // Never check out against availability that did not load.
    if (picker.blocked || itemsLoading) return;
    // Defense in depth with the disabled button above — a disabled Button is a
    // rendering detail. The authoritative gate is RentalsService.assertPermission
    // behind the route; this only saves an honest deep link a round-trip.
    if (!canCreate) {
      Alert.alert(
        'Not allowed',
        'You do not have permission to check out rentals. Ask an admin for the rentals:create permission.',
      );
      return;
    }
    if (lines.length === 0) {
      Alert.alert('Add an item', 'Pick at least one rental item to check out.');
      return;
    }
    if (!expectedReturn) {
      Alert.alert('Expected return required', 'Enter the number of days until return.');
      return;
    }
    if (borrowerEmailInvalid(borrower)) {
      Alert.alert('Check the email', BORROWER_EMAIL_FORMAT_ERROR);
      return;
    }
    setBusy(true);
    try {
      await api<{ id: string }>('/api/v1/rentals', {
        method: 'POST',
        body: {
          warehouseId,
          // borrowerUserId only for a picked team member; a typed name is
          // someone not in StockPilot (lib/rental-borrower.ts).
          ...borrowerRequestFields(borrower),
          expectedReturnAt: expectedReturn.toISOString(),
          notes: notes.trim() || null,
          lines,
        },
      });
      router.back();
    } catch (e) {
      // ApiError.message is the service's own sentence ("Projector B: only 2
      // available to rent…"), already written for an operator — show it as-is
      // rather than a generic failure, which is the whole point of letting the
      // checkout be refusable.
      const message =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Could not check this rental out.';
      Alert.alert('Could not check out', message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} />
        </View>
        <View style={styles.head}>
          <Eyebrow>RENTALS · NEW CHECKOUT</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            Check <Em>out.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >
          <FormSection icon={Warehouse} label="WAREHOUSE">
            {warehousesError !== null ? (
              <ReadFailure
                message="Could not load warehouses."
                detail={warehousesError}
                retrying={warehousesLoading}
                onRetry={() => setWarehousesNonce((n) => n + 1)}
              />
            ) : warehousesLoading && warehouses.length === 0 ? (
              <ActivityIndicator color={c.ink} style={{ paddingVertical: 8 }} />
            ) : warehouses.length === 0 ? (
              <Body size={12.5} muted>
                No active warehouses to check out from. Add one on the web first.
              </Body>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {warehouses.map((w) => {
                  const active = w.id === warehouseId;
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setWarehouseId(w.id)}
                      style={({ pressed }) => [
                        styles.chip,
                        {
                          borderColor: active ? c.ink : c.hair,
                          backgroundColor: active ? c.ink : c.card,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Body
                        size={13}
                        color={active ? c.paper : c.ink2}
                        style={{ fontFamily: FONT.display }}
                      >
                        {w.name}
                      </Body>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </FormSection>

          <FormSection icon={PackageOpen} label={`ITEMS${lines.length > 0 ? ` · ${lines.length}` : ''}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Search size={14} color={c.ink4} strokeWidth={1.5} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search rental items"
                placeholderTextColor={c.ink5}
                autoCapitalize="none"
                style={{
                  flex: 1,
                  fontFamily: FONT.displayRegular,
                  fontSize: 15,
                  height: 40,
                  color: c.ink,
                }}
              />
            </View>

            {!warehouseId && !warehousesLoading ? (
              // No warehouse to pick from (the read failed, or the org has
              // none): said in the WAREHOUSE section above, never a spinner
              // that cannot stop.
              <Body size={12.5} muted>
                Choose a warehouse above to see its rental items.
              </Body>
            ) : itemsLoading || !warehouseId ? (
              // `|| !warehouseId` so the first paint is a spinner rather than
              // "No rental items in this warehouse" — the warehouse list has
              // not resolved yet, so that sentence would be a lie the operator
              // acts on (going to the web to mark items rentable that already
              // are).
              <ActivityIndicator color={c.ink} style={{ paddingVertical: 8 }} />
            ) : picker.blocked ? (
              // The items or their reservations did not load. No list and no
              // steppers: a figure here would be a guess the server refuses.
              <ReadFailure
                message={picker.message ?? 'Could not load rental items.'}
                detail={picker.detail}
                retrying={itemsLoading}
                onRetry={() => setItemsNonce((n) => n + 1)}
              />
            ) : visibleItems.length === 0 ? (
              <Body size={12.5} muted>
                {items.length === 0
                  ? 'No rental items in this warehouse. Mark an item as a rental on the web first.'
                  : 'No rental items match that search.'}
              </Body>
            ) : (
              <View style={{ gap: 10 }}>
                {visibleItems.map((it) => {
                  const avail = availableFor(it);
                  const qty = cart[it.id] ?? 0;
                  return (
                    <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Body size={14} style={{ fontFamily: FONT.display }}>
                          {it.name ?? 'Untitled item'}
                        </Body>
                        <Mono size={10} tracking={0.1} upper color={c.ink4} style={{ marginTop: 2 }}>
                          {it.sku ? `${it.sku} · ` : ''}
                          {avail} AVAILABLE
                        </Mono>
                      </View>
                      <Pressable
                        onPress={() => removeOne(it)}
                        disabled={qty === 0}
                        hitSlop={8}
                        style={[styles.step, { borderColor: c.hair, opacity: qty === 0 ? 0.35 : 1 }]}
                      >
                        <Minus size={14} color={c.ink} strokeWidth={2} />
                      </Pressable>
                      <Mono size={14} color={c.ink} style={{ minWidth: 22, textAlign: 'center' }}>
                        {qty}
                      </Mono>
                      <Pressable
                        onPress={() => addOne(it)}
                        disabled={qty >= avail}
                        hitSlop={8}
                        style={[
                          styles.step,
                          { borderColor: c.hair, opacity: qty >= avail ? 0.35 : 1 },
                        ]}
                      >
                        <Plus size={14} color={c.ink} strokeWidth={2} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </FormSection>

          <FormSection icon={User} label="BORROWER">
            {borrower.userId !== null ? (
              // A picked team member: their name and the account email the
              // rental emails will go to. Change starts a fresh borrower.
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <UserCheck size={16} color={c.ink} strokeWidth={1.5} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Body size={15} style={{ fontFamily: FONT.display }}>
                      {borrower.name}
                    </Body>
                    <Body size={12} muted>
                      {RENTAL_BORROWER_TEAM_MEMBER}
                    </Body>
                  </View>
                  <Pressable
                    onPress={() => setBorrower(someoneElse(borrower))}
                    accessibilityRole="button"
                    accessibilityLabel="Change borrower"
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.chip,
                      { borderColor: c.hair, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 },
                    ]}
                  >
                    <Body size={13} color={c.ink2} style={{ fontFamily: FONT.display }}>
                      Change
                    </Body>
                  </Pressable>
                </View>
                <Body size={12} muted>
                  {borrower.email.trim()
                    ? `Rental emails go to ${borrower.email.trim()}.`
                    : RENTAL_NO_EMAIL_NOTE}
                </Body>
              </View>
            ) : (
              <>
                <Field
                  label="FULL NAME"
                  value={borrower.name}
                  onChangeText={(text) => setBorrower((d) => typeName(d, text))}
                  placeholder="Search team members, or type anyone’s name"
                  autoCapitalize="words"
                  autoCorrect={false}
                />
                {/* Only for someone who may check out (the list is not loaded
                    otherwise, and the screen says why below). */}
                {canCreate ? (
                  <BorrowerSuggestions
                    search={borrowerSearch}
                    draft={borrower}
                    onPick={(member) => setBorrower(pickMember(member))}
                    onRetry={() => setBorrowerNonce((n) => n + 1)}
                  />
                ) : null}
                <Field
                  label="EMAIL (OPTIONAL)"
                  value={borrower.email}
                  onChangeText={(text) => setBorrower((d) => typeEmail(d, text))}
                  placeholder="borrower@company.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {borrowerEmailInvalid(borrower) ? (
                  <Body size={12} color={ACCENT.warn}>
                    {BORROWER_EMAIL_FORMAT_ERROR}
                  </Body>
                ) : null}
                {/* The web picker's words (shared from core): anyone can borrow,
                    and the email is where the rental emails go. */}
                <Body size={12} muted>
                  They do not need a StockPilot account. {RENTAL_BORROWER_EMAIL_HELP}
                </Body>
              </>
            )}
          </FormSection>

          <FormSection icon={Calendar} label="EXPECTED RETURN">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="DAYS FROM TODAY"
                  value={returnDays}
                  onChangeText={setReturnDays}
                  placeholder="7"
                  keyboardType="number-pad"
                />
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
                  RETURN BY
                </Mono>
                <Mono
                  size={14}
                  tracking={-0.012}
                  color={c.ink}
                  style={{ fontFamily: FONT.display, marginTop: 4 }}
                >
                  {expectedReturn
                    ? expectedReturn.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                    : '—'}
                </Mono>
              </View>
            </View>
          </FormSection>

          <FormSection icon={PackageOpen} label="NOTES">
            <Field
              label="ANY CONTEXT (OPTIONAL)"
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. for Saturday's field day, returning via the front office"
              multiline
            />
          </FormSection>

          {/*
            Says what the record actually is, now that it IS the full one. The
            old copy disclosed that nothing was reserved — true of the direct
            insert, false of this path, and leaving it would teach operators to
            distrust a checkout that does hold the stock.
          */}
          <Body size={12.5} muted style={{ marginTop: 8 }}>
            Checking out reserves these units, so they stop showing as available to rent
            elsewhere. The borrower is emailed a confirmation when you add their email. Mark the
            rental returned to release the stock.
          </Body>

          {!canCreate ? (
            <Body size={12.5} muted>
              You do not have permission to check out rentals.
            </Body>
          ) : null}

          <Button block onPress={submit} disabled={!canSubmit} style={{ marginTop: 12 }}>
            {busy ? 'Saving…' : 'Check out'}
          </Button>
          <Button block variant="ghost" onPress={() => router.back()}>
            Cancel
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * Team members matching the typed name, under the name field. A tap picks the
 * member; anything else typed stays a borrower not in StockPilot. When the
 * list could not load, the reason and a retry, and typing still works.
 */
function BorrowerSuggestions({
  search,
  draft,
  onPick,
  onRetry,
}: {
  search: BorrowerSearch;
  draft: BorrowerDraft;
  onPick: (member: RentalBorrowerMember) => void;
  onRetry: () => void;
}) {
  const { c } = useTheme();
  if (search.status === 'failed') {
    return (
      <View style={{ gap: 8 }}>
        <Body size={12} muted>
          {search.message}
        </Body>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Try loading team members again"
          style={({ pressed }) => [
            styles.chip,
            { alignSelf: 'flex-start', borderColor: c.hair, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Body size={13} color={c.ink2} style={{ fontFamily: FONT.display }}>
            Try again
          </Body>
        </Pressable>
      </View>
    );
  }
  if (!draft.name.trim()) return null;
  if (search.status === 'loading') {
    return (
      <Body size={12} muted>
        Looking up team members…
      </Body>
    );
  }
  const { shown, more } = matchBorrowers(search.members, draft);
  if (shown.length === 0) {
    return (
      <Body size={12} muted>
        No team member matches. They will be checked out as someone not in StockPilot.
      </Body>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      {shown.map((member) => (
        <Pressable
          key={member.userId}
          onPress={() => onPick(member)}
          accessibilityRole="button"
          accessibilityLabel={`Check out to ${member.displayName}, team member`}
          style={({ pressed }) => [
            styles.suggestion,
            { borderColor: c.hair, backgroundColor: pressed ? c.paper2 : c.card },
          ]}
        >
          <UserCheck size={14} color={c.ink3} strokeWidth={1.5} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={14} style={{ fontFamily: FONT.display }}>
              {member.displayName}
            </Body>
            {member.email ? (
              <Body size={12} muted>
                {member.email}
              </Body>
            ) : null}
          </View>
        </Pressable>
      ))}
      <Body size={12} muted>
        {more > 0
          ? `${more} more ${more === 1 ? 'match' : 'matches'}. Keep typing to narrow the list. `
          : ''}
        Not on the list? Keep the name as typed: they are someone not in StockPilot.
      </Body>
    </View>
  );
}

function FormSection({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Calendar;
  label: string;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Icon size={14} color={c.ink} strokeWidth={1.5} />
        <Mono size={10.5} tracking={0.12} upper color={c.ink4}>
          {label}
        </Mono>
      </View>
      <View style={{ gap: 12 }}>{children}</View>
    </Card>
  );
}

/**
 * A read that failed: the sentence, the read's own reason, and a Try again
 * that is disabled while the retry runs (a failing read retries for several
 * seconds before its error shows, so repeated taps would stack reloads).
 */
function ReadFailure({
  message,
  detail,
  retrying,
  onRetry,
}: {
  message: string;
  detail: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Body size={13} color={ACCENT.warn}>
        {message}
      </Body>
      {detail ? (
        <Body size={12} muted>
          {detail}
        </Body>
      ) : null}
      <Pressable
        onPress={onRetry}
        disabled={retrying}
        accessibilityRole="button"
        accessibilityState={{ disabled: retrying }}
        style={({ pressed }) => [
          styles.chip,
          {
            alignSelf: 'flex-start',
            borderColor: c.hair,
            backgroundColor: c.card,
            opacity: retrying ? 0.5 : pressed ? 0.85 : 1,
          },
        ]}
      >
        <Body size={13} color={c.ink2} style={{ fontFamily: FONT.display }}>
          Try again
        </Body>
      </Pressable>
    </View>
  );
}

function Field({
  label,
  multiline = false,
  ...rest
}: React.ComponentProps<typeof TextInput> & { label: string; multiline?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <TextInput
        {...rest}
        multiline={multiline}
        placeholderTextColor={c.ink5}
        style={{
          fontFamily: FONT.displayRegular,
          fontSize: 15,
          minHeight: multiline ? 80 : 48,
          paddingHorizontal: 14,
          paddingVertical: multiline ? 10 : 0,
          borderWidth: 1,
          borderColor: c.hair,
          borderRadius: RADIUS.tile,
          color: c.ink,
          backgroundColor: c.paper2,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: RADIUS.tile,
  },
  step: {
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
