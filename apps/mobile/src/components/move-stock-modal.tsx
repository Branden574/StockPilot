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
import { transferStock } from '@/lib/stock-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Holding {
  locationId: string;
  name: string;
  kind: string | null;
  quantity: number;
}

interface Destination {
  id: string;
  name: string;
  kind: string | null;
}

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
 * One modal covers both flows — the source list includes placed racks AND the
 * staging/unplaced buckets, so picking a staging source is a put-away and
 * picking a rack source is a transfer. The destination is either an existing
 * rack/crate OR one created inline via "+ New rack…" (gated on
 * canCreateLocation; the server asserts 'locations:manage' and creates it in the
 * source location's warehouse).
 */
export function MoveStockModal({
  visible,
  itemId,
  itemName,
  itemType,
  organizationId,
  canCreateLocation,
  onClose,
  onMoved,
}: {
  visible: boolean;
  itemId: string;
  itemName: string;
  itemType: string | null;
  organizationId: string;
  canCreateLocation: boolean;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { c, mode } = useTheme();
  const [loading, setLoading] = React.useState(true);
  const [holdings, setHoldings] = React.useState<Holding[]>([]);
  const [destinations, setDestinations] = React.useState<Destination[]>([]);
  const [fromId, setFromId] = React.useState('');
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
    void (async () => {
      // Source holdings: every location this item has stock in (placed racks +
      // staging/unplaced). location_id → qty, with the location's name + kind.
      const holdingsRes = await supabase
        .from('item_stock_levels')
        .select('location_id, quantity, locations!inner(id, name, kind, warehouse_id)')
        .eq('organization_id', organizationId)
        .eq('item_id', itemId)
        .gt('quantity', 0);
      // Destination candidates: real placement locations (racks/crates), never
      // the staging/unplaced system buckets. The server re-checks this.
      const destRes = await supabase
        .from('locations')
        .select('id, name, kind, warehouse_id')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .in('kind', ['rack', 'crate'])
        .order('name', { ascending: true });
      if (cancelled) return;

      const hs: Holding[] = ((holdingsRes.data ?? []) as unknown[])
        .map((r) => {
          const row = r as {
            location_id: string;
            quantity: number | string;
            locations:
              | { name?: string; kind?: string | null }
              | { name?: string; kind?: string | null }[];
          };
          const loc = Array.isArray(row.locations) ? row.locations[0] : row.locations;
          return {
            locationId: row.location_id,
            name: loc?.name ?? 'Location',
            kind: loc?.kind ?? null,
            quantity: Number(row.quantity) || 0,
          };
        })
        .filter((h) => h.quantity > 0);

      const ds: Destination[] = ((destRes.data ?? []) as Destination[]).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
      }));

      setHoldings(hs);
      setDestinations(ds);
      setFromId(hs[0]?.locationId ?? '');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, itemId, organizationId]);

  const selected = holdings.find((h) => h.locationId === fromId) ?? null;
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

  // Existing destinations exclude the chosen source rack (can't move to itself).
  const destChoices = destinations.filter((d) => d.id !== fromId);

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
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {holdings.map((h) => (
                      <Chip
                        key={h.locationId}
                        label={holdingLabel(h)}
                        active={h.locationId === fromId}
                        onPress={() => {
                          setFromId(h.locationId);
                          setQty('1');
                          if (toId === h.locationId) setToId('');
                        }}
                      />
                    ))}
                  </View>
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
