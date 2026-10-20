import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

// Relative imports on purpose (as in checkbox.tsx): touch-target.test.ts
// loads this file in the node test runner, which does not resolve `@/`.
import { FONT, TYPE_CEILING, capTo } from '../../lib/theme';
import { useTheme } from '../../lib/use-theme';
import { Mono } from './text';

/**
 * Returns a windowed page list with ellipses, e.g.:
 *   pageNumbers(1, 8)  → [1, 2, 3, 4, 5, '…', 8]
 *   pageNumbers(5, 8)  → [1, '…', 4, 5, 6, '…', 8]
 *   pageNumbers(8, 8)  → [1, '…', 4, 5, 6, 7, 8]
 */
function pageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result: (number | 'ellipsis')[] = [1];
  if (current <= 4) {
    for (let i = 2; i <= 5; i++) result.push(i);
    result.push('ellipsis');
    result.push(total);
  } else if (current >= total - 3) {
    result.push('ellipsis');
    for (let i = total - 4; i <= total; i++) result.push(i);
  } else {
    result.push('ellipsis');
    for (let i = current - 1; i <= current + 1; i++) result.push(i);
    result.push('ellipsis');
    result.push(total);
  }
  return result;
}

/**
 * Numbered pager for the grouped Items / Books lists.
 *
 * The caller supplies the page COUNT and the row RANGE this page covers rather
 * than a page size to derive them from: those lists paginate over display
 * GROUPS (a SKU family is never split across pages — lib/inventory-paging.ts),
 * so pages hold a variable number of rows and `page × pageSize` would
 * over-claim on a short page and under-claim on a page that ran long to keep a
 * family whole. Everything printed here therefore describes what the page
 * ACTUALLY renders. Mirrors the web table's footer, which prints the same range
 * from `pageStartIndex` (apps/web/src/lib/inventory/instant-mode.ts).
 *
 * Look (the reference pager): page buttons and arrows sit on the card colour
 * with the stronger border, the current page is the ink fill, and the range
 * line is muted ink (information, so ink3, not ink4).
 *
 * THE 44pt TARGET (redesign P2.5c). Each page button and arrow is drawn at
 * 36pt inside a 44 x 44pt frame (the Pressable), the drawn box centred in it,
 * so every target is 44pt while the buttons look as they did. A frame, not
 * hitSlop: the old 4-6pt hitSlop never reached past the row. The frames sit
 * edge to edge (the row has no gap), so the drawn buttons stand 8pt apart
 * (4pt of frame each side; the gap was 6pt). The frame also pads 3pt all
 * round, so a page button its digits grow past 38pt (three digits, or two at
 * the larger text sizes) widens its frame and still stands at least 6pt from
 * its neighbour, sideways and across a wrapped line, as the old gap kept it.
 * The row breaks into as many lines as it did on a 393pt phone; on a 375pt
 * phone a six-page pager (eight controls, 352pt) now takes two lines where it
 * took one. A line is 44pt tall instead of 36pt.
 */
export function Paginator({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  hideRange = false,
}: {
  page: number;
  /** Pages available — derived from GROUPS by the caller, never from a row size. */
  pageCount: number;
  /** 1-based index of the first row on this page within the full filtered set. */
  rangeStart: number;
  /** 1-based index of the last row on this page. */
  rangeEnd: number;
  /** Rows in the full filtered set the pages divide up. */
  total: number;
  onPageChange: (p: number) => void;
  /** The caller prints its own range line (core formatListFooter), so the
   *  SHOWING line here would say the same thing twice. */
  hideRange?: boolean;
}) {
  const { c } = useTheme();
  const totalPages = Math.max(1, pageCount);
  if (totalPages <= 1) return null;
  const start = rangeStart;
  const end = rangeEnd;
  const nums = pageNumbers(page, totalPages);

  return (
    <View style={{ paddingVertical: 18, alignItems: 'center', gap: 12 }}>
      {hideRange ? null : (
        <Mono
          size={10.5}
          tracking={0.12}
          upper
          color={c.ink3}
          maxFontSizeMultiplier={capTo(10.5, TYPE_CEILING.chrome)}
        >
          SHOWING {start.toLocaleString()}–{end.toLocaleString()} OF {total.toLocaleString()}
        </Mono>
      )}
      {/*
        flexWrap + centering is the box fix that pairs with the caps below.
        Nine 52pt buttons on a 353pt screen walked the Next arrow clean off the
        right edge — unreachable, which stranded the user on page 1 of the two
        hottest tabs in the app. Wrapping to a second row keeps every control
        on screen at any text size. No gap: the 44pt frames touch, and the
        frame round each drawn button (4pt at 36pt, never under the frame's
        3pt padding) is the space between them: at least 6pt, as the gap was.
      */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PaginatorArrow
          direction="prev"
          onPress={() => onPageChange(page - 1)}
          disabled={page <= 1}
        />
        {nums.map((n, i) =>
          n === 'ellipsis' ? (
            // A gap marker, not a control: VoiceOver skips it.
            <View
              key={`e${i}`}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ width: 22, alignItems: 'center', justifyContent: 'center' }}
            >
              <Mono
                size={14}
                color={c.ink4}
                maxFontSizeMultiplier={capTo(14, TYPE_CEILING.chrome)}
              >
                ·
              </Mono>
            </View>
          ) : (
            <PageButton
              key={n}
              num={n}
              active={n === page}
              onPress={() => onPageChange(n)}
            />
          ),
        )}
        <PaginatorArrow
          direction="next"
          onPress={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        />
      </View>
    </View>
  );
}

function PageButton({
  num,
  active,
  onPress,
}: {
  num: number;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      // VoiceOver: "Page 2, button, selected" for the page on screen.
      accessibilityRole="button"
      accessibilityLabel={`Page ${num}`}
      accessibilityState={{ selected: active }}
      style={PAGER_FRAME}
    >
      {({ pressed }) => (
        <View
          style={{
            minWidth: PAGER_BUTTON_SIZE,
            // minHeight pairs with the chrome cap on the number below: the
            // button grows with its digits rather than clipping them.
            minHeight: PAGER_BUTTON_SIZE,
            paddingHorizontal: 9,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: active ? c.ink : c.card,
            borderWidth: active ? 0 : 1,
            borderColor: c.hair2,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed && !active ? 0.7 : 1,
          }}
        >
          <Mono
            size={13}
            tracking={-0.012}
            color={active ? c.paper : c.ink}
            maxFontSizeMultiplier={capTo(13, TYPE_CEILING.chrome)}
            style={{ fontFamily: FONT.display }}
          >
            {num}
          </Mono>
        </View>
      )}
    </Pressable>
  );
}

function PaginatorArrow({
  direction,
  onPress,
  disabled,
}: {
  direction: 'prev' | 'next';
  onPress: () => void;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // An icon-only arrow had no words at all for VoiceOver.
      accessibilityRole="button"
      accessibilityLabel={direction === 'prev' ? 'Previous page' : 'Next page'}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={PAGER_FRAME}
    >
      {({ pressed }) => (
        <View
          style={{
            width: PAGER_BUTTON_SIZE,
            height: PAGER_BUTTON_SIZE,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair2,
            backgroundColor: c.card,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.3 : pressed ? 0.7 : 1,
          }}
        >
          <Icon size={16} color={c.ink} strokeWidth={1.6} />
        </View>
      )}
    </Pressable>
  );
}

/** The drawn page button and arrow: 36pt (a page button grows with its
 *  digits). */
export const PAGER_BUTTON_SIZE = 36;

/** The least each page button's and arrow's frame measures each way (the
 *  iOS minimum). */
export const PAGER_MIN_TARGET = 44;

/** The frame: at least 44 x 44pt, the drawn button centred in it at its own
 *  size (alignItems centre, so it is never stretched to the frame). Its 3pt
 *  padding counts inside that minimum (Yoga sizes the padding box), so a 36pt
 *  button still gets a 44pt frame, while a button wider or taller than 38pt
 *  keeps 3pt of frame each side: two neighbours never stand under 6pt apart,
 *  the row's old gap, sideways or across a wrapped line. */
const PAGER_FRAME = {
  minWidth: PAGER_MIN_TARGET,
  minHeight: PAGER_MIN_TARGET,
  paddingHorizontal: 3,
  paddingVertical: 3,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
