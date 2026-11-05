import { StyleSheet } from 'react-native';

import { GLASS_METRICS } from '../metrics';

/**
 * The Items tab in Liquid Glass (iOS-Lookup.dc.html): the layout values the
 * board draws, used only inside the tab's `lg` branches. The tab keeps every
 * control Classic has (Back, Menu, Select, New item, the search field, the
 * filter button, Open scanner, the filter pill and the list), so these are
 * frames and spacing only.
 */
export const GLASS_LOOKUP = StyleSheet.create({
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
  // The large title at the scroll's 16pt edge, 4pt in (.ios-large, margin 0 4).
  head: { paddingHorizontal: 16 + GLASS_METRICS.largeTitle.marginHorizontal, paddingTop: 2 },
  title: { marginTop: 0 },
  // .ios-scroll with the board's gap 14 and padding-top 8 (the search area).
  searchArea: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  // The count line (.ios-sub [707], margin 0 4) 14 under the search field.
  count: { marginTop: 14, marginHorizontal: 4 },
  // .ios-row [709] at the board's 72pt list row: 10/16 padding, 12 gap.
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: GLASS_METRICS.row.gap,
    paddingVertical: GLASS_METRICS.row.paddingVertical,
    paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
  },
  // A group header row (a size run or a SKU with several placements): the
  // same row frame, the chevron in front.
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: GLASS_METRICS.row.gap,
    paddingVertical: GLASS_METRICS.row.paddingVertical,
    paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
  },
});

/** The list separator's inset (--sep-l: 82px): 16 padding, the 52pt thumb, 12 gap, 2. */
export const GLASS_LOOKUP_SEPARATOR_INSET = 82;

/** The board's list thumb (--thumb: 52px). */
export const GLASS_LOOKUP_THUMB = 52;
