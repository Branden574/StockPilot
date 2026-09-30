import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import {
  NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL,
  NEEDED_BY_CHANGE_LABEL,
  READINESS_NEEDS_CONNECTION_COPY,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Card } from '@/components/ui/card';
import { Body, Mono } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The order's needed-by on the phone's order screen, in the organization's
 * zone, with Change beside it for approvers (F2-4): core's row ("Needed by
 * Fri, Oct 3, 2:00 PM", or "No needed-by date", which an approver can set)
 * and core's Change, the web page's words. The button is its own VoiceOver
 * element, 44 pt, named for what it changes ("Change needed-by date"),
 * disabled offline with the reason as its hint. At accessibility text sizes
 * it goes under the date (shouldStackRow).
 */
export function OrderNeededByCard({
  value,
  canChange,
  busy,
  disabled,
  offline,
  onChange,
}: {
  /** What the card prints (lib/order-needed-by neededByCardValue: core's row). */
  value: string;
  /** The viewer may change it (lib/order-needed-by canOfferNeededByChange). */
  canChange: boolean;
  /** The sheet is opening (the zone and access are being read). */
  busy: boolean;
  /** Another action is running. */
  disabled: boolean;
  offline: boolean;
  onChange: () => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stack = shouldStackRow(fontScale);
  const off = disabled || offline || busy;
  return (
    <Card padding={14}>
      <View
        style={{
          flexDirection: stack ? 'column' : 'row',
          alignItems: stack ? 'stretch' : 'center',
          gap: 12,
        }}
      >
        <Body size={15} color={c.ink} style={stack ? undefined : { flex: 1 }}>
          {value}
        </Body>
        {canChange ? (
          <Pressable
            onPress={onChange}
            disabled={off}
            accessibilityRole="button"
            accessibilityLabel={NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL}
            accessibilityState={{ disabled: off, busy }}
            accessibilityHint={offline ? READINESS_NEEDS_CONNECTION_COPY : undefined}
            style={[
              styles.button,
              { borderColor: c.hair, opacity: off && !busy ? 0.5 : 1 },
              stack ? { alignSelf: 'flex-start' } : null,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={c.ink} />
            ) : (
              <Mono size={13} color={c.ink} maxFontSizeMultiplier={BUTTON_CAP}>
                {NEEDED_BY_CHANGE_LABEL}
              </Mono>
            )}
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}

/** The button's label is chrome: it stops at the control ceiling. */
const BUTTON_CAP = capTo(13, TYPE_CEILING.control);

const styles = StyleSheet.create({
  button: {
    minHeight: MIN_TAP,
    minWidth: MIN_TAP,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
