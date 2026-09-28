import * as React from 'react';
import { View } from 'react-native';

import {
  describeReadinessRollup,
  READINESS_NEEDS_CONNECTION_COPY,
  READINESS_READ_FAILED_COPY,
  readinessSummaryForRequester,
  type OrderReadinessResult,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { ReadinessIcon, readinessToneColor } from '@/components/order-line-readiness';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body, Eyebrow } from '@/components/ui/text';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * THE ORDER'S READINESS ROLL-UP (F2-1), above the lines on the order screen:
 * the native twin of the web page's readiness strip.
 *
 * Full panel (approvers, pickers, buyers): the roll-up, worst first ("1 line
 * short", then "2 lines need put-away", then "3 of 6 lines ready to pick"),
 * the needed-by signal, "Checked at 2:14 PM. Stock can change after this."
 * and Check again. Green ("Ready to pick (5 of 5 lines)") only when every line
 * is ready and every fact was readable; there is never an "on track" claim.
 *
 * Requester: one sentence ("Some items are waiting on stock."), no numbers.
 *
 * A FAILED CHECK says "Couldn't check readiness. Try again." with Try again,
 * never an empty card or a green one. Offline the button is disabled and says
 * it needs a connection. Every word is core's (readiness-copy.ts).
 */
export function OrderReadinessSummary({
  result,
  audience,
  timeZone,
  offline,
  checking,
  onCheckAgain,
}: {
  result: OrderReadinessResult;
  audience: 'full' | 'requester';
  /** The organization's zone, for "Checked at" and the needed-by date. */
  timeZone: string | null;
  /** No connection: Check again is disabled, with the reason. */
  offline: boolean;
  /** A check is running (the button is disabled meanwhile). */
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const { c, mode } = useTheme();

  if (audience === 'requester') {
    const sentence = readinessSummaryForRequester(result);
    if (!sentence) return null;
    return (
      <Card padding={14}>
        <Eyebrow>STOCK</Eyebrow>
        <Body size={14} color={c.ink} style={{ marginTop: 8 }}>
          {sentence}
        </Body>
      </Card>
    );
  }

  const rollup = describeReadinessRollup(result, { timeZone: timeZone ?? undefined });
  if (!rollup) return null;
  const failed = result.state === 'failed';
  const color = readinessToneColor(rollup.tone, c, mode);
  // The failure's own reason, when it says more than the headline does.
  const detail =
    result.state === 'failed' &&
    result.message &&
    !READINESS_READ_FAILED_COPY.startsWith(result.message)
      ? result.message
      : null;

  return (
    <Card padding={14}>
      <Eyebrow>READINESS</Eyebrow>
      <View style={{ marginTop: 8, gap: 4 }}>
        <View
          accessible
          accessibilityRole={failed ? 'alert' : 'header'}
          accessibilityLabel={rollup.headline}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
        >
          <View style={{ paddingTop: 3 }}>
            <ReadinessIcon icon={rollup.icon} size={16} color={color} />
          </View>
          <Body size={15} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
            {rollup.headline}
          </Body>
        </View>
        {detail ? (
          <Body size={13} muted>
            {detail}
          </Body>
        ) : null}
        {rollup.details.map((d, i) => (
          <Body key={i} size={13.5} color={c.ink2}>
            {d}
          </Body>
        ))}
        {rollup.neededBy ? (
          <Body size={13.5} color={ACCENT.warn}>
            {rollup.neededBy}
          </Body>
        ) : null}
        {rollup.checkedAt ? (
          <Body size={12.5} muted>
            {rollup.checkedAt}
          </Body>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={offline || checking}
          onPress={onCheckAgain}
          accessibilityHint="Checks this order's stock again"
          // 44 pt, not the small Button's 36.
          style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
        >
          {checking ? 'Checking...' : failed ? 'Try again' : 'Check again'}
        </Button>
        {offline ? (
          <Body size={12.5} muted>
            {READINESS_NEEDS_CONNECTION_COPY}
          </Body>
        ) : null}
      </View>
    </Card>
  );
}
