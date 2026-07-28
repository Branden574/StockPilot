import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Mono } from '@/components/ui/text';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Returns a windowed page list with ellipses, e.g.:
 *   pageNumbers(1, 8)  → [1, 2, 3, 4, 5, '…', 8]
 *   pageNumbers(5, 8)  → [1, '…', 4, 5, 6, '…', 8]
 *   pageNumbers(8, 8)  → [1, '…', 4, 5, 6, 7, 8]
 */
function pageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result: Array<number | 'ellipsis'> = [1];
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
 */
export function Paginator({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
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
}) {
  const { c } = useTheme();
  const totalPages = Math.max(1, pageCount);
  if (totalPages <= 1) return null;
  const start = rangeStart;
  const end = rangeEnd;
  const nums = pageNumbers(page, totalPages);

  return (
    <View style={{ paddingVertical: 18, alignItems: 'center', gap: 12 }}>
      <Mono
        size={10.5}
        tracking={0.12}
        upper
        color={c.ink4}
        maxFontSizeMultiplier={capTo(10.5, TYPE_CEILING.chrome)}
      >
        SHOWING {start.toLocaleString()}–{end.toLocaleString()} OF {total.toLocaleString()}
      </Mono>
      {/*
        flexWrap + centering is the box fix that pairs with the caps below.
        Nine 52pt buttons on a 353pt screen walked the Next arrow clean off the
        right edge — unreachable, which stranded the user on page 1 of the two
        hottest tabs in the app. Wrapping to a second row keeps every control
        on screen at any text size.
      */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <PaginatorArrow
          direction="prev"
          onPress={() => onPageChange(page - 1)}
          disabled={page <= 1}
        />
        {nums.map((n, i) =>
          n === 'ellipsis' ? (
            <View
              key={`e${i}`}
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
      hitSlop={4}
      style={({ pressed }) => ({
        minWidth: 36,
        // minHeight pairs with the chrome cap on the number below: the button
        // grows with its digits rather than clipping them.
        minHeight: 36,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: active ? c.ink : 'transparent',
        borderWidth: active ? 0 : 1,
        borderColor: c.hair,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed && !active ? 0.7 : 1,
      })}
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
      hitSlop={6}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.hair,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : pressed ? 0.7 : 1,
      })}
    >
      <Icon size={16} color={c.ink} strokeWidth={1.6} />
    </Pressable>
  );
}
