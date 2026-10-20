/**
 * The invisible touch target the patterns' small controls share with the
 * shared Button (components/ui/button.tsx): below sm and on coarse pointers a
 * transparent ::before grows the hit area to at least 44 x 44 around the
 * control without moving anything, so the control keeps its desktop size and
 * a filter row on a touch tablet stays one height with the 32 px search field
 * beside it. The control needs `relative` (included).
 *
 * A later sibling's area paints over an earlier one, so controls that use it
 * keep (44 - height) / 2 px between them: 6 px for the 32 px filter trigger,
 * 8 px for the 28 px chips (FilterBar's gap-2 gives 8).
 */
export const touchTargetClass =
  "relative before:absolute before:left-1/2 before:top-1/2 before:size-full before:min-h-11 before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-none max-sm:before:content-[''] pointer-coarse:before:content-['']";

/**
 * The room an 18 px text action that uses the target above ("Add to group",
 * "Rename group": chipActionClass) needs from the line above or below it.
 * Where the target is on (below sm, or a coarse pointer) it reaches
 * (44 - 18) / 2 = 13 px past the action's top and bottom, so a neighbouring
 * line keeps 14 px (3.5) from it: then no part of the target lies over another
 * control or over text someone may want to select, such as a SKU. Elsewhere
 * the line keeps its own spacing. `textActionTouchGapY` goes on a wrapping
 * line of actions (or on a wrapping line that holds one), and
 * `textActionTouchMarginTop` on the line under an action.
 */
export const textActionTouchGapY = 'max-sm:gap-y-3.5 pointer-coarse:gap-y-3.5';
export const textActionTouchMarginTop = 'max-sm:mt-3.5 pointer-coarse:mt-3.5';
