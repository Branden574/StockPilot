import * as React from 'react';
import {
  ActivityIndicator,
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
import { removeStockFromLocation } from '@/lib/stock-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Holding {
  locationId: string;
  name: string;
  kind: string | null;
  quantity: number;
}

/**
 * Native "Remove from rack" — the write-off parity for the web
 * RemoveFromRackDialog (apps/web/src/components/inventory/remove-from-rack-dialog.tsx).
 * Draws down ONE holding, leaving the item's stock in every OTHER rack alone —
 * the tool a warehouse manager reaches for after consolidating a rack, instead
 * of archiving (which would hide the whole item and orphan the stock it holds
 * elsewhere).
 *
 * Holdings are read straight from Supabase (RLS-scoped, like the rest of the
 * item screen); the WRITE goes through removeStockFromLocation() →
 * POST /api/v1/items/<id>/remove-stock, which routes through
 * InventoryService.removeStockFromLocation → adjustStock so the 'stock:adjust'
 * permission is enforced server-side (the raw adjust_stock RPC only checks the
 * staff-role floor). A reason is MANDATORY and the quantity is capped at the
 * chosen holding — the server re-checks both, so a normal user never hits a
 * server error as the first line of defence.
 *
 * Only PLACED holdings are offered (racks/crates and any other non-system
 * location), never the staging/unplaced buckets — mirroring the web dialog,
 * which is surfaced per placed holding on the item detail.
 */
export function RemoveFromRackModal({
  visible,
  itemId,
  itemName,
  organizationId,
  onClose,
  onRemoved,
}: {
  visible: boolean;
  itemId: string;
  itemName: string;
  organizationId: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { c, mode } = useTheme();
  const [loading, setLoading] = React.useState(true);
  const [holdings, setHoldings] = React.useState<Holding[]>([]);
  const [fromId, setFromId] = React.useState('');
  const [qty, setQty] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFromId('');
    setQty('');
    setReason('');
    void (async () => {
      const res = await supabase
        .from('item_stock_levels')
        .select('location_id, quantity, locations!inner(id, name, kind)')
        .eq('organization_id', organizationId)
        .eq('item_id', itemId)
        .gt('quantity', 0);
      if (cancelled) return;

      const hs: Holding[] = ((res.data ?? []) as unknown[])
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
        // Placed holdings only — staging/unplaced are owned by the put-away
        // flow, not the write-off (web parity: placements-breakdown excludes
        // them, and that is where the web dialog is surfaced).
        .filter((h) => h.quantity > 0 && h.kind !== 'staging' && h.kind !== 'unplaced');

      // Open on the first placed holding with its whole quantity in the box —
      // the common case is "clear this rack".
      const first = hs[0];
      setHoldings(hs);
      setFromId(first?.locationId ?? '');
      setQty(first ? String(first.quantity) : '');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, itemId, organizationId]);

  const selected = holdings.find((h) => h.locationId === fromId) ?? null;
  const maxQty = selected?.quantity ?? 0;
  const qtyNum = parseInt(qty, 10);
  const qtyValid = !Number.isNaN(qtyNum) && qtyNum > 0 && qtyNum <= maxQty;
  const canSubmit = !!fromId && qtyValid && reason.trim().length > 0 && !submitting;

  async function submit() {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await removeStockFromLocation(itemId, {
        locationId: selected.locationId,
        quantity: qtyNum,
        reason: reason.trim(),
      });
      onRemoved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove stock.');
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

            <Eyebrow>REMOVE FROM RACK</Eyebrow>
            <Display size={24} style={{ marginTop: 10 }}>
              {itemName}
            </Display>
            <Mono size={11.5} color={c.ink4} style={{ marginTop: 8, lineHeight: 18 }}>
              Writes off stock from one rack. Stock in every other rack is left untouched, and this
              is recorded in the item&apos;s history.
            </Mono>

            {loading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={c.ink4} />
              </View>
            ) : holdings.length === 0 ? (
              <Mono size={13} color={c.ink4} style={{ marginTop: 18, lineHeight: 20 }}>
                This item has no placed stock to remove. Anything on hand is still in staging or
                unplaced — put it away first, or adjust on-hand with a reason.
              </Mono>
            ) : (
              <ScrollView
                style={{ marginTop: 18 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={{ gap: 6, marginBottom: 16 }}>
                  <Mono size={10} tracking={0.12} upper color={c.ink4}>
                    RACK / CRATE
                  </Mono>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {holdings.map((h) => (
                      <Chip
                        key={h.locationId}
                        label={`${h.name} · ${h.quantity}`}
                        active={h.locationId === fromId}
                        onPress={() => {
                          setFromId(h.locationId);
                          // Re-seed the whole-holding default against the newly
                          // chosen rack, so a partial edit never carries over.
                          setQty(String(h.quantity));
                        }}
                      />
                    ))}
                  </View>
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
                      QUANTITY TO REMOVE
                    </Mono>
                    <Mono size={10.5} color={c.ink4}>
                      {maxQty} in {selected?.name ?? 'rack'}
                    </Mono>
                  </View>
                  <TextInput
                    value={qty}
                    onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ''))}
                    placeholder="0"
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
                      Only {maxQty} in this rack.
                    </Mono>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 4 }}>
                  <Mono size={10} tracking={0.12} upper color={c.ink4}>
                    REASON *
                  </Mono>
                  <TextInput
                    value={reason}
                    onChangeText={setReason}
                    placeholder="e.g. Damaged in storage, cycle-count correction"
                    placeholderTextColor={c.ink5}
                    maxLength={500}
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
                <Button block variant="destructive" onPress={submit} disabled={!canSubmit}>
                  {submitting ? 'Removing…' : 'Remove stock'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
