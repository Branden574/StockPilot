import { X } from 'lucide-react-native';
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
  useWindowDimensions,
  View,
} from 'react-native';

import { Body, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import {
  canRemoveOrderLine,
  describeLineEditError,
  describeQuantityFloor,
  LINE_EDIT_INDETERMINATE_COPY,
  LINE_EDIT_INDETERMINATE_TITLE,
  LINE_EDIT_RESERVATION_SYNC_COPY,
  LINE_EDIT_RESERVATION_SYNC_TITLE,
  lineEditErrorIsIndeterminate,
  lineEditErrorIsReservationSync,
  lineEditErrorIsStale,
  lineQuantityFloor,
  parseLineQuantity,
  removeLineConfirmCopy,
  stepLineQuantity,
  validateLineQuantity,
  type EditableOrderLine,
  type LineQuantityResult,
  type LineRemovedResult,
} from './edit-order-line';

/**
 * Native "correct a line on an existing order" sheet — the mobile twin of the
 * web line-editing UI, and the missing other half of AddOrderItemsSheet (owner,
 * 2026-07-22: "theres no way to delete the item you added if you added the
 * wrong one or edit the amount").
 *
 * Both operations go through the Bearer twins on
 * /api/v1/orders/[id]/lines — PATCH { lineId, quantity } and
 * DELETE ?lineId=… — which hand straight to
 * OrderRequestsService.updateLineQuantity / removeLine, the SAME methods the
 * web server actions call. Every rule this sheet applies locally is therefore a
 * cosmetic mirror (edit-order-line.ts), never the boundary: it exists so the
 * user sees the constraint on the stepper instead of discovering it in a 409.
 *
 * One sheet covers both operations on purpose. "I picked the wrong item" and "I
 * picked the wrong number" are the same moment for the person holding the
 * phone, and splitting them would put the fix for half of them behind a second
 * affordance nobody would find.
 */
export function EditOrderLineSheet({
  visible,
  onClose,
  orderId,
  line,
  totalLines,
  onChanged,
  onRemoved,
  onRequestReload,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  /** The line being corrected, or null while the sheet is closed. */
  line: EditableOrderLine | null;
  /** Lines on the order — removing the last one is refused (R5). */
  totalLines: number;
  onChanged: (line: EditableOrderLine, result: LineQuantityResult) => void;
  onRemoved: (line: EditableOrderLine, result: LineRemovedResult) => void;
  /** Called when the failure means the screen's picture of the order is stale
   *  (order shipped, line gone, permission revoked) so it can reload/re-gate. */
  onRequestReload: () => void;
}) {
  const { c, mode } = useTheme();
  const { height } = useWindowDimensions();
  const [qty, setQty] = React.useState('');
  const [busy, setBusy] = React.useState<'save' | 'remove' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed from the server's number every time the sheet opens (and whenever
  // a reload changes the line under it), so a previous session's draft can
  // never be submitted against a different line.
  const requested = line?.requested ?? 0;
  const lineId = line?.orderRequestLineId ?? null;
  React.useEffect(() => {
    if (!visible) return;
    setQty(String(requested));
    setError(null);
  }, [visible, lineId, requested]);

  const floor = line ? lineQuantityFloor(line) : 1;
  const floorNote = line ? describeQuantityFloor(line) : null;
  const removal = line
    ? canRemoveOrderLine({ line, totalLines })
    : ({ ok: false, reason: '' } as const);
  const parsed = parseLineQuantity(qty);
  // Fixed pixel height off the window — percentage/aspectRatio sizing is what
  // collapsed the size-count grid under Fabric, so no sheet uses it.
  const bodyMaxHeight = Math.round(height * 0.5);

  function requestClose() {
    if (busy !== null) return;
    onClose();
  }

  function step(delta: number) {
    setQty((prev) => String(stepLineQuantity(parseLineQuantity(prev) ?? requested, delta, floor)));
    setError(null);
  }

  /** Shared failure handling for both writes. */
  function handleFailure(e: unknown) {
    const message = describeLineEditError(e);
    if (lineEditErrorIsStale(e)) {
      // Session died, grant revoked, or the line/order is gone — nothing typed
      // in here can fix that. Close, say why in an Alert (an inline message on
      // a sheet closing in the same frame is never read), and let the screen
      // reload and re-gate.
      setError(null);
      onClose();
      Alert.alert('Could not change this line', message);
      onRequestReload();
    } else if (lineEditErrorIsIndeterminate(e)) {
      // No HTTP status came back. Retrying is safe (PATCH sets an absolute
      // quantity, DELETE removes one addressed row), but the sheet is now
      // showing a number that may already be wrong, so refresh before letting
      // the user act again.
      setError(null);
      onClose();
      Alert.alert(LINE_EDIT_INDETERMINATE_TITLE, LINE_EDIT_INDETERMINATE_COPY);
      onRequestReload();
    } else if (lineEditErrorIsReservationSync(e)) {
      // The line write COMMITTED and only the reservation re-sync failed (the
      // service writes the line first on purpose — a stray hold self-corrects
      // when the order closes, a missing one does not). Keeping this in the
      // sheet would show the old quantity next to a message about stock, and
      // invite the user to repeat an edit that already landed. Close, say what
      // did and did not happen, reload.
      setError(null);
      onClose();
      Alert.alert(LINE_EDIT_RESERVATION_SYNC_TITLE, LINE_EDIT_RESERVATION_SYNC_COPY);
      onRequestReload();
    } else {
      // 400/409/429/500 — the service's message names the floor or the state,
      // which is exactly what the user needs while still looking at the field.
      setError(message);
    }
  }

  async function save() {
    if (!line || !line.orderRequestLineId || busy !== null) return;
    if (parsed === null) {
      setError('Enter a whole number above zero.');
      return;
    }
    // No-op: the service succeeds quietly and writes no audit event (U5), so
    // there is nothing to gain from the round trip either.
    if (parsed === line.requested) {
      onClose();
      return;
    }
    const check = validateLineQuantity(line, parsed);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const res = await api<{ ok: true; quantity: number; pickSlipStale: boolean }>(
        `/api/v1/orders/${orderId}/lines`,
        { method: 'PATCH', body: { lineId: line.orderRequestLineId, quantity: parsed } },
      );
      onChanged(line, {
        quantity: Number(res.quantity) || parsed,
        pickSlipStale: res.pickSlipStale === true,
      });
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!line || !line.orderRequestLineId || busy !== null) return;
    setBusy('remove');
    setError(null);
    try {
      const res = await api<{ ok: true; removedItemId: string; pickSlipStale: boolean }>(
        // The line id travels as a query parameter because DELETE bodies are
        // unreliable across the RN fetch stack — the route reads it from there.
        `/api/v1/orders/${orderId}/lines?lineId=${encodeURIComponent(line.orderRequestLineId)}`,
        { method: 'DELETE' },
      );
      onRemoved(line, {
        removedItemId: String(res.removedItemId ?? line.itemId ?? ''),
        pickSlipStale: res.pickSlipStale === true,
      });
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(null);
    }
  }

  function confirmRemove() {
    if (!line || busy !== null) return;
    if (!removal.ok) {
      setError(removal.reason);
      return;
    }
    const copy = removeLineConfirmCopy(line);
    Alert.alert(copy.title, copy.message, [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Remove item', style: 'destructive', onPress: () => void remove() },
    ]);
  }

  const stepBtn = (label: string, delta: number, disabled: boolean) => (
    <Pressable
      onPress={() => step(delta)}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={delta > 0 ? 'Increase quantity' : 'Decrease quantity'}
      style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.hair,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Mono size={17} color={c.ink}>
        {label}
      </Mono>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/*
       * React Native does NOT reposition Modal content for the software
       * keyboard, and this sheet is bottom-anchored, so without this the
       * quantity field, its floor note and both buttons sit under the iOS
       * keyboard the instant the field is focused. Same wrapper
       * add-order-items-sheet / move-stock-modal use.
       */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={requestClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              gap: 12,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
                Edit line
              </Body>
              <Pressable onPress={requestClose} hitSlop={8} accessibilityLabel="Close">
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>

            {line === null ? null : (
              // keyboardShouldPersistTaps="handled": the default ("never") makes
              // the FIRST tap after typing dismiss the keyboard and never reach
              // the child, so Save / Remove / the steppers silently do nothing
              // until tapped twice.
              <ScrollView
                style={{ maxHeight: bodyMaxHeight }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 14 }}
              >
                <View>
                  <Body size={15} color={c.ink} numberOfLines={3}>
                    {line.name}
                  </Body>
                  <Mono size={11} color={c.ink4} style={{ marginTop: 3 }}>
                    {`Ordered ${line.requested}${line.fulfilled > 0 ? ` · ${line.fulfilled} handed over` : ''}${line.picked > 0 ? ` · ${line.picked} staged` : ''}`}
                  </Mono>
                </View>

                <View style={{ gap: 8 }}>
                  <Eyebrow>QUANTITY</Eyebrow>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {stepBtn('−', -1, busy !== null || (parsed ?? requested) <= floor)}
                    <TextInput
                      value={qty}
                      onChangeText={(t) => {
                        setQty(t);
                        setError(null);
                      }}
                      keyboardType="number-pad"
                      returnKeyType="done"
                      editable={busy === null}
                      accessibilityLabel="Quantity ordered"
                      style={[
                        styles.qtyInput,
                        { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink },
                      ]}
                    />
                    {stepBtn('+', 1, busy !== null)}
                  </View>
                  {floorNote ? (
                    <Mono size={10.5} color={c.ink4}>
                      {floorNote}
                    </Mono>
                  ) : null}
                </View>

                <View style={{ gap: 6 }}>
                  <Pressable
                    onPress={confirmRemove}
                    disabled={busy !== null || !removal.ok}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${line.name} from this order`}
                    style={[
                      styles.action,
                      {
                        borderWidth: 1,
                        borderColor: c.hair,
                        opacity: busy !== null || !removal.ok ? 0.45 : 1,
                      },
                    ]}
                  >
                    {busy === 'remove' ? (
                      <ActivityIndicator color={ACCENT.crit} />
                    ) : (
                      <Mono size={13} color={ACCENT.crit}>
                        Remove from order
                      </Mono>
                    )}
                  </Pressable>
                  {/* Disabled-with-reason: a greyed-out Remove with no
                      explanation is how the picker ends up believing the app is
                      broken. The reason is the service's own wording. */}
                  {!removal.ok && removal.reason ? (
                    <Mono size={10.5} color={c.ink4}>
                      {removal.reason}
                    </Mono>
                  ) : null}
                </View>
              </ScrollView>
            )}

            {error ? (
              <Mono size={11} color={ACCENT.crit}>
                {error}
              </Mono>
            ) : null}

            <Pressable
              onPress={() => void save()}
              disabled={busy !== null || line === null}
              accessibilityRole="button"
              style={[styles.action, { backgroundColor: c.ink, opacity: busy !== null ? 0.6 : 1 }]}
            >
              {busy === 'save' ? (
                <ActivityIndicator color={c.paper} />
              ) : (
                <Mono size={13} color={c.paper}>
                  Save quantity
                </Mono>
              )}
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  qtyInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontFamily: FONT.mono,
    fontSize: 15,
    textAlign: 'center',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: 10,
  },
});
