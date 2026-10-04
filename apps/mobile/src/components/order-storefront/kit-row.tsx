import * as React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import {
  KIT_ADD_COPY,
  KIT_DETAILS_COPY,
  componentItem,
  kitAvailability,
  kitLimitedByCopy,
  kitsAvailableCopy,
  type KitOffer,
  type StorefrontItem,
} from '@stockpilot/core';

import { Body, Mono } from '@/components/ui/text';
import {
  addKitLabel,
  decreaseKitLabel,
  increaseBlockedHint,
  increaseKitLabel,
  kitRowLabel,
} from '@/lib/order-storefront/a11y';
import { itemRowStacked } from '@/lib/order-storefront/layout';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { SmallAction, Stepper } from './controls';

/**
 * ONE KIT (phone ordering PO-4, Bundles module on): "Add kit", then a kit
 * stepper; every change is all or nothing (core planKitChange, applied by the
 * screen). "Details" lists what each kit holds. The kit's count in the cart
 * and what limits it come from core (kitsInCart, kitAvailability).
 */
export const KitRow = React.memo(function KitRow({
  kit,
  itemMap,
  inCart,
  maxInCart,
  locked,
  onChange,
  onDetails,
}: {
  kit: KitOffer;
  itemMap: ReadonlyMap<string, StorefrontItem>;
  /** Kits the cart holds now. */
  inCart: number;
  /** The most the cart can hold (core maxKits). */
  maxInCart: number;
  locked: boolean;
  onChange: (bundleId: string, target: number) => void;
  onDetails: (bundleId: string) => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = itemRowStacked(fontScale);
  const avail = kitAvailability(kit, itemMap);
  const limiting = avail.limiting ? componentItem(avail.limiting.component, itemMap) : null;
  const out = avail.kits < 1;

  return (
    <View style={[styles.row, { borderColor: c.hair, backgroundColor: c.card }, stacked && styles.rowStacked]}>
      <View
        accessible
        accessibilityLabel={kitRowLabel(kit, itemMap, inCart)}
        style={{ flex: 1, minWidth: 0, gap: 3 }}
      >
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {kit.name}
        </Body>
        <Mono size={11.5} color={out ? ACCENT.crit : c.ink4}>
          {kitsAvailableCopy(avail.kits)}
        </Mono>
        {limiting && avail.limiting ? (
          <Mono size={11} color={c.ink4}>
            {kitLimitedByCopy(limiting.name, avail.limiting.available)}
          </Mono>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {inCart > 0 ? (
          <Stepper
            quantity={inCart}
            available={maxInCart}
            atMax={inCart >= maxInCart}
            disabled={locked}
            decLabel={decreaseKitLabel(kit.name, inCart)}
            incLabel={increaseKitLabel(kit.name)}
            countLabel={`${kit.name}: ${inCart} in your cart`}
            incHint={increaseBlockedHint(inCart >= maxInCart)}
            onDec={() => onChange(kit.bundleId, inCart - 1)}
            onInc={() => onChange(kit.bundleId, inCart + 1)}
            onCount={() => onDetails(kit.bundleId)}
          />
        ) : (
          <SmallAction
            label={KIT_ADD_COPY}
            accessibilityLabel={addKitLabel(kit.name)}
            disabled={locked || out || maxInCart < 1}
            onPress={() => onChange(kit.bundleId, 1)}
          />
        )}
        <SmallAction
          label={KIT_DETAILS_COPY}
          accessibilityLabel={`${KIT_DETAILS_COPY}: ${kit.name}`}
          variant="ghost"
          onPress={() => onDetails(kit.bundleId)}
        />
      </View>
    </View>
  );
});

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
});
