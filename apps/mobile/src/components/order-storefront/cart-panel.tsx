import * as React from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import {
  CART_CHECK_OUT_COPY,
  CART_CLEAR_ALL_COPY,
  CART_CLEAR_CONFIRM_COPY,
  CART_CLEAR_COPY,
  CART_EMPTY_BODY_COPY,
  CART_EMPTY_TITLE_COPY,
  CART_KEEP_COPY,
  CART_SUGGESTIONS_LABEL_COPY,
  CART_TITLE_COPY,
  STOREFRONT_ADD_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  STOREFRONT_REMOVE_COPY,
  availableOf,
  cartCountsCopy,
  type CartState,
  type StorefrontItem,
} from '@stockpilot/core';

import { Body, Mono } from '@/components/ui/text';
import {
  addItemLabel,
  cartBarLabel,
  decreaseLabel,
  increaseBlockedHint,
  increaseLabel,
  quantityButtonLabel,
} from '@/lib/order-storefront/a11y';
import { cartLineView, checkoutTotals } from '@/lib/order-storefront/checkout';
import { MIN_TAP } from '@/lib/order-storefront/layout';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { SmallAction, Stepper } from './controls';

/**
 * THE CART'S LINES (phone ordering PO-4), in the cart sheet on a phone and the
 * persistent cart column on an iPad: each line with its stepper (+ stops at
 * what is available), the web's warnings (more than available is kept and
 * said; a line that can no longer be ordered is marked and must be removed),
 * totals, and Clear all with core's confirm. An empty cart says so and offers
 * "Start with your usuals" (Frequently ordered). Every change goes through the
 * session, which refuses it while the cart is locked.
 */
export function CartPanel({
  cart,
  itemMap,
  notOrderable,
  locked,
  usuals,
  onInc,
  onDec,
  onQuantity,
  onRemove,
  onAdd,
  onClear,
}: {
  cart: CartState;
  itemMap: ReadonlyMap<string, StorefrontItem>;
  notOrderable: ReadonlySet<string>;
  locked: boolean;
  /** Frequently ordered items to start an empty cart with. */
  usuals: readonly StorefrontItem[];
  onInc: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onQuantity: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onAdd: (itemId: string) => void;
  onClear: () => void;
}) {
  const { c } = useTheme();
  const totals = checkoutTotals(cart);

  if (cart.lines.length === 0) {
    return (
      <View style={{ gap: 10 }}>
        <Body size={16} color={c.ink} style={{ fontFamily: FONT.display }}>
          {CART_EMPTY_TITLE_COPY}
        </Body>
        <Body size={13.5} color={c.ink3}>
          {CART_EMPTY_BODY_COPY}
        </Body>
        {usuals.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Mono size={11} color={c.ink4} upper tracking={0.12}>
              {CART_SUGGESTIONS_LABEL_COPY}
            </Mono>
            {usuals.map((item) => (
              <View key={item.id} style={styles.usual}>
                <Body size={14} color={c.ink} style={{ flex: 1, minWidth: 0 }}>
                  {item.name}
                </Body>
                <SmallAction
                  label={STOREFRONT_ADD_COPY}
                  accessibilityLabel={addItemLabel(item.name)}
                  disabled={locked || availableOf(item) < 1}
                  onPress={() => onAdd(item.id)}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  const confirmClear = () =>
    Alert.alert(CART_CLEAR_CONFIRM_COPY, undefined, [
      { text: CART_KEEP_COPY, style: 'cancel' },
      { text: CART_CLEAR_COPY, style: 'destructive', onPress: onClear },
    ]);

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.header}>
        <Body
          size={16}
          color={c.ink}
          accessibilityRole="header"
          style={{ fontFamily: FONT.display, flex: 1, minWidth: 0 }}
        >
          {`${CART_TITLE_COPY} · ${cartCountsCopy(totals.lines, totals.units)}`}
        </Body>
        <SmallAction label={CART_CLEAR_ALL_COPY} variant="ghost" disabled={locked} onPress={confirmClear} />
      </View>
      {cart.lines.map((line) => {
        const item = itemMap.get(line.itemId);
        const name = item?.name ?? line.itemId;
        const available = item ? availableOf(item) : 0;
        const unorderable = notOrderable.has(line.itemId);
        // Marked only from a catalog answer (or the server's refusal): while
        // the catalog loads, a line it does not name yet is not marked.
        const view = cartLineView(line, item, unorderable);
        const note = view.note;
        return (
          <View key={line.itemId} style={[styles.line, { borderColor: c.hair }]}>
            <View style={{ gap: 2 }}>
              <Body size={14.5} color={c.ink}>
                {view.title}
              </Body>
              {item?.sku ? (
                <Mono size={11} color={c.ink4}>
                  {item.sku}
                </Mono>
              ) : null}
              {note ? (
                <Body size={12.5} color={note.kind === 'at_max' ? c.ink3 : ACCENT.crit}>
                  {note.kind === 'not_orderable' ? STOREFRONT_LINE_NOT_ORDERABLE_COPY : note.message}
                </Body>
              ) : null}
            </View>
            <View style={styles.lineControls}>
              {view.stepper ? (
                <Stepper
                  quantity={line.quantity}
                  available={available}
                  atMax={line.quantity >= available}
                  disabled={locked}
                  decLabel={decreaseLabel(name, line.quantity)}
                  incLabel={increaseLabel(name)}
                  countLabel={quantityButtonLabel(name, line.quantity)}
                  incHint={increaseBlockedHint(line.quantity >= available)}
                  onDec={() => onDec(line.itemId)}
                  onInc={() => onInc(line.itemId)}
                  onCount={() => onQuantity(line.itemId)}
                />
              ) : null}
              <SmallAction
                label={STOREFRONT_REMOVE_COPY}
                accessibilityLabel={`${STOREFRONT_REMOVE_COPY} ${name}`}
                variant="ghost"
                disabled={locked}
                onPress={() => onRemove(line.itemId)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The phone's bottom bar: "3 items · 12 units" and Check out. */
export function CartBar({
  cart,
  onOpenCart,
  onCheckOut,
}: {
  cart: CartState;
  onOpenCart: () => void;
  onCheckOut: () => void;
}) {
  const { c } = useTheme();
  const totals = checkoutTotals(cart);
  if (totals.lines === 0) return null;
  return (
    <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.hair }]}>
      <Pressable
        onPress={onOpenCart}
        accessibilityRole="button"
        accessibilityLabel={`${CART_TITLE_COPY}, ${cartCountsCopy(totals.lines, totals.units)}`}
        style={({ pressed }) => [styles.barCounts, { opacity: pressed ? 0.8 : 1 }]}
      >
        <Mono size={13} color={c.ink} maxFontSizeMultiplier={BAR_CAP}>
          {cartCountsCopy(totals.lines, totals.units)}
        </Mono>
      </Pressable>
      <Pressable
        onPress={onCheckOut}
        accessibilityRole="button"
        accessibilityLabel={cartBarLabel(totals.lines, totals.units)}
        style={({ pressed }) => [styles.barCheckout, { backgroundColor: c.ink, opacity: pressed ? 0.85 : 1 }]}
      >
        <Mono size={13.5} color={c.paper} maxFontSizeMultiplier={BAR_CAP}>
          {CART_CHECK_OUT_COPY}
        </Mono>
      </Pressable>
    </View>
  );
}

/** The bar is chrome over the list: its words stop at the control ceiling
 *  and the bar grows with them (minHeight). */
const BAR_CAP = capTo(13.5, TYPE_CEILING.control);

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  usual: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { borderTopWidth: 1, paddingTop: 10, gap: 8 },
  lineControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  barCounts: { flex: 1, minWidth: 0, minHeight: MIN_TAP, justifyContent: 'center' },
  barCheckout: {
    minHeight: MIN_TAP,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 1,
  },
});
