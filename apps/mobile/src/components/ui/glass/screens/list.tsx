import { StyleSheet } from 'react-native';

import { GLASS_METRICS } from '../metrics';

/**
 * The shared list screen (components/data-list-screen.tsx) in Liquid Glass:
 * an inferred extension of the iOS list boards (iOS-Lookup.dc.html, the
 * Orders list of iPad-Compact.dc.html and the title block of
 * iOS-Home.dc.html; the rows are the grouped lists of Routes-Gallery-1 and
 * -2 drawn by each screen; sp.css line numbers in brackets). Used only inside
 * the frame's `lg` branches. The frame keeps every control Classic has (Back,
 * Menu, the screen's trailing control, its header controls, the list, its
 * empty, failed and offline states), so these are frames and spacing; each
 * row is the screen's own Card, which is the grouped glass surface in Liquid
 * Glass.
 */
export const GLASS_LIST = StyleSheet.create({
  // .ios-nav [700]: 52 tall, 16 side padding, 10 between its buttons.
  nav: {
    minHeight: GLASS_METRICS.nav.height,
    paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: GLASS_METRICS.nav.gap,
  },
  navGroup: { flexDirection: 'row', alignItems: 'center', gap: GLASS_METRICS.nav.gap },
  // The title block at the scroll's 16pt edge (.ios-scroll [698]; .ios-large
  // [702] has no margin of its own, so the boards' titles start at 16), 2pt
  // under the nav (iOS-Home: .col.g2, margin-top 2). Its 4pt foot and the
  // list's 10pt top put the first row 14 under it: the scroll's gap on
  // iOS-Lookup and iPad-Compact.
  head: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 },
  title: { marginTop: 0 },
  // The line under the title (.ios-sub [707], margin 0 on iOS-Home), 2pt
  // under it: the boards draw a title's meta line there, never over it.
  sub: { marginTop: 2 },
  // .ios-scroll [698]: 16 from the sides. 10 between the rows is Classic's
  // gap, kept: a screen that draws its rows as one surface takes it back
  // (screens/movements.tsx LIST_GAP), so those rows meet in both looks.
  list: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
    gap: 10,
  },
  // The empty, failed and offline panel on the grouped surface, as
  // iOS-Lookup draws "No items match" inside its group (.col.ac.g8,
  // padding 32 16).
  empty: { paddingVertical: 32, paddingHorizontal: 16, alignItems: 'center' },
  // The words over rows an earlier read left, on the boards' status line
  // (iOS-Item, iOS-Count: an .ios-group [708] with its tint, padding 12 14,
  // its parts 10 apart).
  reloadNote: {
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: GLASS_METRICS.group.radius,
  },
});

/**
 * The panel's rhythm (iOS-Lookup's empty group): the 28pt glyph (i28), 8
 * between the glyph, the title and the words (.g8), and the boards' Lucide
 * stroke (1.8).
 */
export const GLASS_LIST_PANEL = { glyph: 28, gap: 8, strokeWidth: 1.8 } as const;

/**
 * The large title's words: the title and its emphasis as one plain line, the
 * boards' titles drawing no italic emphasis and no closing full stop
 * ("Order requests." reads "Order requests"). Every word stays.
 */
export function glassListTitle(title: string, italic?: string): string {
  const tail = (italic ?? '').trim().replace(/\.$/, '');
  return tail ? `${title} ${tail}` : title;
}
