/** DOM id of the permanent topbar entry. Focus returns here when the drawer closes. */
export const WHATS_NEW_ENTRY_ID = 'whats-new-entry';

/**
 * Touch targets: about 44px wherever a finger is the pointer. That is below the
 * `sm` breakpoint (where the card spans the screen and the drawer is a
 * full-screen sheet) AND on any coarse pointer at any width (a tablet, a
 * touchscreen laptop). A mouse keeps the app's compact size.
 *
 * The coarse-pointer rule is an ARBITRARY variant on purpose: Tailwind emits
 * arbitrary variants after named ones, so it wins over `sm:` when both match. A
 * named `pointer-coarse:` would depend on variant order to beat `sm:`.
 */
export const TOUCH_TARGET = 'min-h-11 sm:min-h-9 [@media(pointer:coarse)]:min-h-11';
/** The same rule for a square icon button. `compact` is its mouse size. */
export const TOUCH_TARGET_ICON = {
  8: 'size-11 sm:size-8 [@media(pointer:coarse)]:size-11',
  10: 'size-11 sm:size-10 [@media(pointer:coarse)]:size-11',
} as const;
