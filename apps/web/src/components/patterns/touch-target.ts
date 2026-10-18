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
