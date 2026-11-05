/**
 * Geometry of the glass primitives, copied from the artifact's iOS rules
 * (project/sp.css; line numbers in brackets). Colours never live here: they
 * come from the generated tokens through useTheme().
 */
export const GLASS_METRICS = {
  /** .ios-nav [700]: 52 tall, 16 side padding. */
  nav: { height: 52, paddingHorizontal: 16, gap: 10 },
  /** .ios-circ [703]: the 44pt round icon button. */
  circle: { size: 44, iconSize: 20 },
  /** .ios-group [708]: radius 24. */
  group: { radius: 24 },
  /** .ios-row [709-711]: 56 min, 10/16 padding, 12 gap, separator inset 16 (.5pt). */
  row: { minHeight: 56, paddingVertical: 10, paddingHorizontal: 16, gap: 12, separatorInset: 16 },
  /** .ios-btn [716]: 50 min, radius 25, 10/22 padding. */
  button: { minHeight: 50, radius: 25, paddingVertical: 10, paddingHorizontal: 22 },
  /** .ios-search [721]: 44 tall, radius 22, 14 side padding, 8 gap. */
  search: { height: 44, radius: 22, paddingHorizontal: 14, gap: 8, fontSize: 17, iconSize: 18 },
  /** .ios-seg [722-723]: 3 padding, radius 20 track, 32 tall segments radius 17, 2 gap. */
  segmented: { padding: 3, radius: 20, segmentHeight: 32, segmentRadius: 17, gap: 2 },
  /** .ios-sheet [740-741]: 8 from the edges, radius 36, padding 8/18/22, 14 gap; grabber 36x5. */
  sheet: {
    inset: 8,
    radius: 36,
    paddingTop: 8,
    paddingHorizontal: 18,
    paddingBottom: 22,
    gap: 14,
    grabberWidth: 36,
    grabberHeight: 5,
  },
  /** .item-actions [768]: the floating action bar, as the tab capsule: 16 / 16 / 22, 64 tall, radius 32. */
  actionBar: {
    left: 16,
    right: 16,
    bottom: 22,
    height: 64,
    radius: 32,
    gap: 8,
    paddingHorizontal: 7,
  },
  /** Large titles: 4pt side margin as .ios-h [706]. */
  largeTitle: { marginHorizontal: 4 },
} as const;
