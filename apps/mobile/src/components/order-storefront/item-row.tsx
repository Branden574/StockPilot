import * as React from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import {
  availabilityLabel,
  availableOf,
  frequentlyOrderedTagCopy,
  glyphFor,
  statusOf,
  STOREFRONT_ADD_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  type StorefrontItem,
} from '@stockpilot/core';

import { CachedImage } from '@/components/ui/cached-image';
import { Body, Mono } from '@/components/ui/text';
import {
  ITEM_ROW_HINT,
  addBlockedHint,
  addItemLabel,
  changeLockedHint,
  decreaseLabel,
  increaseBlockedHint,
  increaseLabel,
  itemRowLabel,
  quantityButtonLabel,
} from '@/lib/order-storefront/a11y';
import { itemRowStacked } from '@/lib/order-storefront/layout';
import { earmarkLabel } from '@/lib/order-storefront/setup';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { SmallAction, Stepper } from './controls';

/**
 * ONE ORDERABLE ITEM (phone ordering PO-4): a two-line row (photo, the name
 * wrapping, "SKU · 134 available", the earmark chip) with Add, then a stepper
 * that stops at what is available. Memoized: the list passes stable
 * id-taking callbacks (onAdd(itemId), never a closure per row) and the
 * quantity as a scalar from a Map, so a keystroke in search or a change to
 * another line never re-renders this row (memory
 * reference_mobile_items_perf_solved). The text half is ONE VoiceOver element
 * with the name, availability and quantity in the cart; each stepper button
 * is its own and names the item. Past the 1.4 text size the control drops
 * under the text, so a long name keeps the full width.
 */
export const ItemRow = React.memo(function ItemRow({
  item,
  quantity,
  photoUrl,
  rank,
  notOrderable,
  refusal = null,
  locked,
  onOpen,
  onAdd,
  onInc,
  onDec,
  onQuantity,
  onPhotoError,
}: {
  item: StorefrontItem;
  quantity: number;
  photoUrl: string | null;
  rank?: { place: number; orders: number };
  notOrderable: boolean;
  /** Why the server refused this item (core's sentence), or null: said in
   *  place of the generic mark (PO-4 review). */
  refusal?: string | null;
  locked: boolean;
  onOpen: (itemId: string) => void;
  onAdd: (itemId: string) => void;
  onInc: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onQuantity: (itemId: string) => void;
  onPhotoError: () => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = itemRowStacked(fontScale);
  const available = availableOf(item);
  const status = statusOf(item);
  const earmark = earmarkLabel(item);
  const out = status === 'out';

  const control =
    quantity > 0 ? (
      <Stepper
        quantity={quantity}
        available={available}
        atMax={quantity >= available}
        disabled={locked}
        decLabel={decreaseLabel(item.name, quantity)}
        incLabel={increaseLabel(item.name)}
        countLabel={quantityButtonLabel(item.name, quantity)}
        incHint={increaseBlockedHint(quantity >= available)}
        lockHint={changeLockedHint(locked)}
        onDec={() => onDec(item.id)}
        onInc={() => onInc(item.id)}
        onCount={() => onQuantity(item.id)}
      />
    ) : (
      <SmallAction
        label={STOREFRONT_ADD_COPY}
        accessibilityLabel={addItemLabel(item.name)}
        disabled={locked || out || notOrderable}
        hint={addBlockedHint({ locked, notOrderable, out })}
        onPress={() => onAdd(item.id)}
      />
    );

  return (
    <View style={[styles.row, { borderColor: c.hair, backgroundColor: c.card }, stacked && styles.rowStacked]}>
      <Pressable
        onPress={() => onOpen(item.id)}
        accessibilityRole="button"
        accessibilityLabel={itemRowLabel(item, quantity, earmark, { rank, notOrderable, refusal })}
        accessibilityHint={ITEM_ROW_HINT}
        // Stacked (past the row threshold), the photo sits above the name so
        // the name has the row's full width and a long word is not broken
        // mid-word (simulator walk D7).
        style={({ pressed }) => [styles.main, stacked && styles.mainStacked, { opacity: pressed ? 0.8 : 1 }]}
      >
        <View style={[styles.photo, { backgroundColor: c.paper2, borderColor: c.hair }]}>
          {photoUrl ? (
            <CachedImage uri={photoUrl} style={styles.photoImage} recyclingKey={item.id} onError={onPhotoError} />
          ) : (
            <Mono size={13} color={c.ink3} maxFontSizeMultiplier={GLYPH_CAP}>
              {glyphFor(item.name)}
            </Mono>
          )}
        </View>
        <View style={stacked ? styles.textStacked : styles.text}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {item.name}
          </Body>
          <Mono size={11.5} color={out ? ACCENT.crit : status === 'low' ? ACCENT.warn : c.ink4}>
            {[item.sku, availabilityLabel(status, available, 'long')].filter(Boolean).join(' · ')}
          </Mono>
          {rank ? (
            <Mono size={11} color={c.ink4}>
              {frequentlyOrderedTagCopy(rank.place, rank.orders)}
            </Mono>
          ) : null}
          {earmark ? (
            <View style={[styles.chip, { borderColor: c.hair }]}>
              <Mono size={10.5} color={c.ink3} maxFontSizeMultiplier={CHIP_CAP}>
                {earmark}
              </Mono>
            </View>
          ) : null}
          {notOrderable ? (
            <Body size={12.5} color={ACCENT.crit}>
              {refusal ?? STOREFRONT_LINE_NOT_ORDERABLE_COPY}
            </Body>
          ) : null}
        </View>
      </Pressable>
      <View style={stacked ? styles.controlStacked : styles.control}>{control}</View>
    </View>
  );
});

const GLYPH_CAP = capTo(13, TYPE_CEILING.chrome);
const CHIP_CAP = capTo(10.5, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  rowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 },
  mainStacked: { flexDirection: 'column', alignItems: 'stretch' },
  text: { flex: 1, minWidth: 0, gap: 3 },
  /** Under the photo: as tall as its lines, the row's full width. */
  textStacked: { gap: 3 },
  photo: {
    width: 48,
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoImage: { width: 48, height: 48 },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 2,
  },
  control: { flexShrink: 0 },
  controlStacked: { alignSelf: 'flex-start' },
});
