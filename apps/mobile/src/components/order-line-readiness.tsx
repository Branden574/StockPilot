import {
  CircleCheck,
  CircleHelp,
  ChevronDown,
  ChevronUp,
  Clock,
  Package,
  PackageCheck,
  TriangleAlert,
} from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import {
  describeReadinessHold,
  describeReadinessLine,
  describeReadinessWhy,
  putAwayLineAccessibilityLabel,
  READINESS_NEEDS_CONNECTION_COPY,
  readinessLineAccessibilityLabel,
  readinessLineChip,
  type PutAwayOffer,
  type ReadinessCopyOptions,
  type ReadinessItemAssessment,
  type ReadinessLineAssessment,
  type ReadinessTone,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Body, Mono } from '@/components/ui/text';
import { pillTone, type Tone } from '@/components/ui/tones';
import type { ReplacementReadinessGate } from '@/lib/order-readiness';
import { TYPE_CEILING, capTo, type Palette } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * ONE ORDER LINE'S READINESS (F2-1), under the line on the order screen: the
 * native twin of the web page's Readiness column.
 *
 * Compact: the state (an icon AND its label, never colour alone) and one
 * sentence. "Why" expands the numbers behind it (on record, held for other
 * orders, in Staging, on order...) and a link to the item, where its stock and
 * last physical count are. Every word is core's (readiness-copy.ts), so the
 * phone and the web page say the same thing about the same line.
 *
 * VoiceOver: the state row is one element, "Line 2, Needs put-away, 4 in
 * Staging", a button that shows or hides why. The sentence, the hold and each
 * part of "Why" are their own elements (a label on a Pressable would silence
 * the text inside it). Targets are at least 44pt; the chip and "Why" are
 * chrome, capped for Dynamic Type; the sentences are content and grow.
 *
 * RX-2 review fix P6: the chip is core's readinessLineChip, so while an
 * exchange replacement's return-first gate holds (`gate`) a ready line reads
 * "Waiting for return" (info, clock), on screen and to VoiceOver; its sentence
 * and hold are unchanged.
 *
 * PUT AWAY (F2-3): a line with units in this warehouse's Staging (core
 * putAwayLineOffer, whatever the line's state) offers "Put away", which opens
 * the Staging tab filtered to its item; VoiceOver hears "Put away 4 of Maus I
 * from Staging". Without stock:transfer the line offers nothing (the card
 * says core's sentence once, as on the web page). The button is its own
 * element, a sibling of the state row.
 *
 * The redesign look: the state chip is the reference's status label
 * (DESIGN-SPEC 6.10): ready on the accent wash, a warning on the warning
 * wash, a refusal on the refusal wash, information as the neutral chip and
 * anything else as the outline chip, each tone's words and icon at AA on its
 * own fill in both modes (they were the single-mode amber, red and mint on
 * the inset fill, under AA in one mode each).
 */

/** The platform icon for core's generic icon key (READINESS_STATES.icon).
 *  Decorative: the label next to it says the same. */
export function ReadinessIcon({
  icon,
  size,
  color,
}: {
  icon: string;
  size: number;
  color: string;
}) {
  switch (icon) {
    case 'check':
      return <CircleCheck size={size} color={color} strokeWidth={2} />;
    case 'package':
      return <Package size={size} color={color} strokeWidth={2} />;
    case 'clock':
      return <Clock size={size} color={color} strokeWidth={2} />;
    case 'alert':
      return <TriangleAlert size={size} color={color} strokeWidth={2} />;
    case 'handed':
      return <PackageCheck size={size} color={color} strokeWidth={2} />;
    default:
      return <CircleHelp size={size} color={color} strokeWidth={2} />;
  }
}

/** Colour for a tone's words and icon on the card or the page, per mode.
 *  Supplementary only: the label and icon carry the state. */
export function readinessToneColor(
  tone: ReadinessTone,
  c: Pick<Palette, 'accent' | 'warnText' | 'critText' | 'ink2' | 'ink3'>,
): string {
  switch (tone) {
    case 'success':
      return c.accent;
    case 'warning':
      return c.warnText;
    case 'danger':
      return c.critText;
    case 'info':
      return c.ink2;
    default:
      return c.ink3;
  }
}

/** The state chip's colours (DESIGN-SPEC 6.10): the shared pill tones for
 *  ready, warning, refusal and anything else (the outline chip), and the
 *  reference's neutral chip (ink2 on the recessed fill, the stronger border)
 *  for information. */
export function readinessChipTone(tone: ReadinessTone, c: Palette): Tone {
  switch (tone) {
    case 'success':
      return pillTone('ok', c);
    case 'warning':
      return pillTone('warn', c);
    case 'danger':
      return pillTone('crit', c);
    case 'info':
      return { fg: c.ink2, bg: c.sunk, border: c.hair2 };
    default:
      return pillTone('default', c);
  }
}

/** Chrome text size and its Dynamic Type ceiling. */
const CHIP_SIZE = 11;
const CHIP_CAP = capTo(CHIP_SIZE, TYPE_CEILING.chrome);

/** The state chip: icon plus label. Not an accessibility element itself (the
 *  row that holds it carries the full label). */
export function ReadinessStateChip({
  icon,
  label,
  tone,
}: {
  icon: string;
  label: string;
  tone: ReadinessTone;
}) {
  const { c } = useTheme();
  const chip = readinessChipTone(tone, c);
  const color = chip.fg;
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        flexShrink: 1,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: chip.border,
        backgroundColor: chip.bg,
      }}
    >
      <ReadinessIcon icon={icon} size={13} color={color} />
      <Mono
        size={CHIP_SIZE}
        tracking={0.02}
        color={color}
        maxFontSizeMultiplier={CHIP_CAP}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Mono>
    </View>
  );
}

export function OrderLineReadiness({
  line,
  item,
  position,
  timeZone,
  onOpenItem,
  putAway = null,
  gate = null,
}: {
  line: ReadinessLineAssessment;
  /** The line's item assessment (null or not visible: nothing more to say). */
  item: ReadinessItemAssessment | null;
  /** The line's place on screen (1-based), for the spoken "Line N". */
  position: number;
  /** The organization's zone, for PO expected dates. */
  timeZone: string | null;
  /** Opens the item screen (stock, last physical count, Count). */
  onOpenItem?: (itemId: string) => void;
  /** F2-3: the line's put-away offer (lib/order-put-away.ts), or null when it
   *  has nothing in Staging. `disabled` offline or while an action runs;
   *  `offline` says why. */
  putAway?: {
    offer: Extract<PutAwayOffer, { kind: 'link' }>;
    disabled: boolean;
    offline: boolean;
    onPress: (itemIds: string[]) => void;
  } | null;
  /** RX-2 review fix P6: an exchange replacement's return-first gate, only
   *  while it holds: a ready line reads "Waiting for return" (info, clock). */
  gate?: ReplacementReadinessGate | null;
}) {
  const { c } = useTheme();
  const [open, setOpen] = React.useState(false);
  const opts: ReadinessCopyOptions = { timeZone: timeZone ?? undefined, ...gate };
  // The chip's words, tone and icon are core's (readinessLineChip), the web
  // pill's rule: "Waiting for return" on a ready line while the gate holds.
  const chip = readinessLineChip(line, opts);
  const sentence = describeReadinessLine(line, item, opts);
  const hold = describeReadinessHold(line.hold);
  // Nothing more to explain for an item the reader cannot see.
  const why = item && item.visible && item.facts ? describeReadinessWhy(item, opts).parts : null;
  const label = readinessLineAccessibilityLabel({ ...line, position }, opts);

  const chipView = <ReadinessStateChip icon={chip.icon} label={chip.label} tone={chip.tone} />;

  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 2 }}>
      {why ? (
        <Pressable
          onPress={() => setOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={open ? 'Hides why' : 'Shows why'}
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => ({
            minHeight: MIN_TAP,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          {chipView}
          <View style={{ flex: 1 }} />
          <Mono size={CHIP_SIZE} color={c.ink3} maxFontSizeMultiplier={CHIP_CAP}>
            {open ? 'Hide why' : 'Why'}
          </Mono>
          {open ? <ChevronUp size={14} color={c.ink3} /> : <ChevronDown size={14} color={c.ink3} />}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={label}
          style={{ minHeight: MIN_TAP, flexDirection: 'row', alignItems: 'center' }}
        >
          {chipView}
        </View>
      )}
      <Body size={13} color={c.ink2}>
        {sentence}
      </Body>
      {hold ? (
        <Body size={12.5} muted>
          {hold}
        </Body>
      ) : null}
      {putAway ? (
        <Button
          size="sm"
          variant="outline"
          disabled={putAway.disabled}
          onPress={() => putAway.onPress(putAway.offer.itemIds)}
          accessibilityLabel={putAwayLineAccessibilityLabel(line)}
          accessibilityHint={putAway.offline ? READINESS_NEEDS_CONNECTION_COPY : undefined}
          // 44 pt, not the small Button's 36.
          style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP }}
        >
          {putAway.offer.label}
        </Button>
      ) : null}
      {open && why ? (
        <View style={{ marginTop: 4, gap: 2 }}>
          {why.map((part, i) => (
            <Body key={i} size={12.5} muted>
              {part}
            </Body>
          ))}
          {onOpenItem ? (
            <Pressable
              onPress={() => onOpenItem(line.itemId)}
              accessibilityRole="link"
              accessibilityHint="Opens the item, with its stock and last physical count"
              style={({ pressed }) => ({
                minHeight: MIN_TAP,
                justifyContent: 'center',
                alignSelf: 'flex-start',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Body size={13} color={c.ink} style={{ textDecorationLine: 'underline' }}>
                Open item
              </Body>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
