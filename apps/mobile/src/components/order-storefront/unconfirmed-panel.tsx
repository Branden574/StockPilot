import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';

import {
  ORDER_CHECK_AND_FINISH_COPY,
  ORDER_DONT_SEND_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  ORDER_SEE_MY_ORDERS_COPY,
  ORDER_UNCONFIRMED_TITLE_COPY,
  orderSubmissionCanResend,
  orderUnconfirmedCopy,
  type OrderSubmissionState,
} from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { showUnconfirmedPanel } from '@/lib/order-storefront/submit';
import { Body } from '@/components/ui/text';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { SmallAction } from './controls';

/**
 * THE UNCONFIRMED PANEL (plan 3.4, section 6): "Your order request is not
 * confirmed", core's sentence for why, and the three ways on: Check and finish
 * (the same key and body again), Don't send it (withdraw; its answer is
 * final), See my orders. The cart stays locked until the key is settled. The
 * sentence is a role alert and is announced when it changes (iOS gives a
 * Text no live region). Offline, both sends are off and say they need a
 * connection; a body an earlier build wrote is never resent (Check and finish
 * is not offered).
 */
export function UnconfirmedPanel({
  state,
  busy,
  offline,
  warehouseName,
  itemName,
  onCheckAndFinish,
  onDontSend,
  onSeeOrders,
}: {
  state: OrderSubmissionState;
  busy: boolean;
  offline: boolean;
  warehouseName: string | null;
  itemName: (itemId: string) => string | null;
  onCheckAndFinish: () => void;
  onDontSend: () => void;
  onSeeOrders: () => void;
}) {
  const { c } = useTheme();
  const live = state.phase === 'unconfirmed' || state.phase === 'withdrawing' ? state : null;
  const pending = state.phase === 'sending' || live ? (state as Extract<OrderSubmissionState, { pending: unknown }>).pending : null;
  const message = live
    ? orderUnconfirmedCopy(live.last, {
        surface: 'phone',
        itemName,
        warehouseName,
        bodyUnreadable: pending?.bodyUnreadable === true,
      })
    : null;
  const lastSpoken = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (message && message !== lastSpoken.current) {
      lastSpoken.current = message;
      AccessibilityInfo.announceForAccessibility(`${ORDER_UNCONFIRMED_TITLE_COPY}. ${message}`);
    }
  }, [message]);

  if (!showUnconfirmedPanel(state)) return null;
  const waiting = busy || state.phase !== 'unconfirmed';
  const sendHint = offline ? ORDER_NEEDS_CONNECTION_COPY : undefined;
  return (
    <Card padding={14}>
      <View style={{ gap: 10 }}>
        <Body size={15.5} color={ACCENT.warn} accessibilityRole="header" style={{ fontFamily: FONT.display }}>
          {ORDER_UNCONFIRMED_TITLE_COPY}
        </Body>
        {message ? (
          <Body size={13.5} color={c.ink} accessibilityRole="alert">
            {message}
          </Body>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {orderSubmissionCanResend(state) || state.phase === 'sending' ? (
            <SmallAction
              label={ORDER_CHECK_AND_FINISH_COPY}
              variant="primary"
              busy={state.phase === 'sending'}
              disabled={waiting || offline}
              hint={sendHint}
              onPress={onCheckAndFinish}
            />
          ) : null}
          <SmallAction
            label={ORDER_DONT_SEND_COPY}
            busy={state.phase === 'withdrawing'}
            disabled={waiting || offline}
            hint={sendHint}
            onPress={onDontSend}
          />
          <SmallAction label={ORDER_SEE_MY_ORDERS_COPY} variant="ghost" onPress={onSeeOrders} />
        </View>
      </View>
    </Card>
  );
}
