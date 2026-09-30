import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';

import {
  describeReadinessForRequester,
  describeReadinessRollup,
  HOLD_AVAILABLE_STOCK_LABEL,
  READINESS_NEEDS_CONNECTION_COPY,
  type OrderReadinessResult,
  type PutAwayOffer,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { ReadinessIcon, readinessToneColor } from '@/components/order-line-readiness';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body, Eyebrow } from '@/components/ui/text';
import { readinessFailureAnnouncement } from '@/lib/order-readiness';
import type { ShortfallPoOffer } from '@/lib/order-shortfall-po';
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
 * Requester: one sentence ("Some items are waiting on stock."), no numbers,
 * when it was checked, and Check again: the web strip's requester layout,
 * both from core describeReadinessForRequester.
 *
 * A FAILED CHECK says "Couldn't check readiness. Try again." (the requester:
 * "Stock couldn't be checked just now.") with Try again, never an empty card
 * or a green one. Under the headline, only the reasons core
 * readinessFailureDetail names (the web page shows the same line). Offline the
 * button is disabled and says it needs a connection. Every word is core's
 * (readiness-copy.ts).
 *
 * VoiceOver hears a failure when it appears: the web's role="alert" is spoken
 * as it renders, but the 'alert' role gives iOS no trait, so the card
 * announces the failure itself (F2-1 phone walk, O2).
 *
 * HOLD AVAILABLE STOCK (F2-2): on the full panel, when the screen offers it
 * (core shouldOfferHoldStock: approvers, hold statuses, some line not or
 * partly held), the web strip's button. 44 pt, disabled while anything runs
 * and offline (the card already says it needs a connection).
 *
 * PUT AWAY N ITEMS (F2-3): on the full panel, when some line has units in
 * this warehouse's Staging (core putAwayStripOffer): "Put away 3 items" opens
 * the Staging tab filtered to them; without stock:transfer, core's sentence
 * instead ("Putting stock away needs the Transfer stock permission."). 44 pt,
 * disabled while anything runs and offline.
 *
 * DRAFT PO FOR WHAT IS SHORT (F2-5): on the full panel, when something on
 * the order may be drafted (lib/order-shortfall-po.ts shortfallPoOffer, the
 * web strip's rule): the button for a manager holding purchase_orders:manage
 * with Orders and Purchase orders on, which opens the draft sheet; core's
 * sentence instead for anyone else ("Drafting a PO needs a manager with
 * purchase-order access."). 44 pt, disabled while anything runs and offline.
 */
/** What "Draft PO for what is short" does, for VoiceOver. */
export const SHORTFALL_PO_STRIP_HINT = 'Opens a sheet to draft purchase orders for what this order is short';
/** What "Put away N items" does, for VoiceOver. */
export const PUT_AWAY_STRIP_HINT = 'Opens Staging with these items, to put them away';

export function OrderReadinessSummary({
  result,
  audience,
  timeZone,
  offline,
  checking,
  onCheckAgain,
  hold = null,
  putAway = null,
  shortfallPo = null,
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
  /** F2-2 "Hold available stock", when offered (full panel only); null: not
   *  offered. `busy`: the hold is running; `disabled`: another action is. */
  hold?: { busy: boolean; disabled: boolean; onPress: () => void } | null;
  /** F2-3 "Put away N items" (full panel only), from lib/order-put-away.ts;
   *  null: nothing in Staging. `disabled`: another action is running. */
  putAway?: {
    offer: PutAwayOffer;
    disabled: boolean;
    onPress: (itemIds: string[]) => void;
  } | null;
  /** F2-5 "Draft PO for what is short" (full panel only), from
   *  lib/order-shortfall-po.ts shortfallPoOffer; null: not offered.
   *  `disabled`: another action is running. */
  shortfallPo?: {
    offer: Exclude<ShortfallPoOffer, { kind: 'none' }>;
    disabled: boolean;
    onPress: () => void;
  } | null;
}) {
  const { c, mode } = useTheme();
  const opts = { timeZone: timeZone ?? undefined };

  // Announced when the failure appears, keyed on its words: a re-render, or a
  // Try again that fails the same way, does not repeat it; a new failure (or
  // one after a success) does.
  const announcement = readinessFailureAnnouncement(result, audience, opts);
  React.useEffect(() => {
    if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  // Check again (Try again after a failure), on both cards: 44 pt, disabled
  // while a check runs and offline, with the reason.
  const recheck = (failedNow: boolean) => (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={offline || checking}
        onPress={onCheckAgain}
        accessibilityHint="Checks this order's stock again"
        // 44 pt, not the small Button's 36.
        style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
      >
        {checking ? 'Checking...' : failedNow ? 'Try again' : 'Check again'}
      </Button>
      {offline ? (
        <Body size={12.5} muted>
          {READINESS_NEEDS_CONNECTION_COPY}
        </Body>
      ) : null}
    </>
  );

  if (audience === 'requester') {
    const card = describeReadinessForRequester(result, opts);
    if (!card) return null;
    const tone = readinessToneColor(card.tone, c, mode);
    return (
      <Card padding={14}>
        <Eyebrow>STOCK</Eyebrow>
        <View style={{ marginTop: 8, gap: 4 }}>
          <View
            accessible
            accessibilityRole={card.failed ? 'alert' : 'text'}
            accessibilityLabel={card.sentence}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
          >
            <View style={{ paddingTop: 2 }}>
              <ReadinessIcon icon={card.icon} size={16} color={tone} />
            </View>
            <Body size={14} color={c.ink} style={{ flex: 1 }}>
              {card.sentence}
            </Body>
          </View>
          {card.checkedAt ? (
            <Body size={12.5} muted>
              {card.checkedAt}
            </Body>
          ) : null}
          {recheck(card.failed)}
        </View>
      </Card>
    );
  }

  const rollup = describeReadinessRollup(result, opts);
  if (!rollup) return null;
  const putAwayOffer = putAway?.offer ?? null;
  const failed = result.state === 'failed';
  const color = readinessToneColor(rollup.tone, c, mode);
  // A failure's own reason, when core names one (the web strip shows the same).
  const detail = rollup.detail;

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
        {putAway && putAwayOffer?.kind === 'link' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={offline || putAway.disabled}
            onPress={() => putAway.onPress(putAwayOffer.itemIds)}
            accessibilityHint={
              offline ? READINESS_NEEDS_CONNECTION_COPY : PUT_AWAY_STRIP_HINT
            }
            // 44 pt, not the small Button's 36.
            style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
          >
            {putAwayOffer.label}
          </Button>
        ) : putAwayOffer?.kind === 'needs_permission' ? (
          <Body size={12.5} muted>
            {putAwayOffer.message}
          </Body>
        ) : null}
        {shortfallPo && shortfallPo.offer.kind === 'button' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={offline || checking || shortfallPo.disabled}
            onPress={shortfallPo.onPress}
            accessibilityLabel={shortfallPo.offer.accessibilityLabel}
            accessibilityHint={offline ? READINESS_NEEDS_CONNECTION_COPY : SHORTFALL_PO_STRIP_HINT}
            // 44 pt, not the small Button's 36.
            style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
          >
            {shortfallPo.offer.label}
          </Button>
        ) : shortfallPo?.offer.kind === 'needs_permission' ? (
          <Body size={12.5} muted>
            {shortfallPo.offer.message}
          </Body>
        ) : null}
        {hold ? (
          <Button
            size="sm"
            variant="outline"
            disabled={offline || checking || hold.disabled}
            onPress={hold.onPress}
            accessibilityHint="Holds the stock that is free now for this order's lines"
            // 44 pt, not the small Button's 36.
            style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
          >
            {hold.busy ? 'Holding...' : HOLD_AVAILABLE_STOCK_LABEL}
          </Button>
        ) : null}
        {recheck(failed)}
      </View>
    </Card>
  );
}
