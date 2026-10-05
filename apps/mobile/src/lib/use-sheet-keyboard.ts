import * as React from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import { createFieldRevealer } from './sheet-field-reveal';

/**
 * The keyboard in a bottom sheet with a note field (the exception sheets:
 * Acknowledge / Add note / Confirm this count, Add a photo, Remove this
 * photo?). R1 walk, 2026-09-29, iPhone 17 at AX5: with the keyboard up the
 * focused note was not moved into view, and only the sheet's own buttons put
 * the keyboard away.
 *
 *   - The focused note is scrolled back into view whenever the body's window
 *     changes under it, once the keyboard has shown, and on focus
 *     (lib/sheet-field-reveal.ts). Wire: `const [attachBody, kb] =
 *     useSheetKeyboard()`; the body ScrollView takes `ref={attachBody}`,
 *     `onBodyScroll` (with scrollEventThrottle 16), `onBodyLayout` and
 *     `onBodyContentSizeChange`; the View that holds the note's label, field
 *     and counter, directly in the body, takes `onNoteBlockLayout`; the
 *     TextInput takes `onNoteFocus`, `onNoteBlur` and `onNoteLayout`.
 *   - A drag on the body puts the keyboard away: the ScrollView sets
 *     keyboardDismissMode="on-drag" (the app's list screens do the same) and
 *     keeps keyboardShouldPersistTaps="handled", so a tap on the body's text
 *     puts it away too and a tap on a button there still works.
 *   - A tap on the card outside the body (the title, the reason lines, the
 *     space around the buttons) puts the keyboard away: the card takes
 *     `claimTapOutside` as onStartShouldSetResponder and `onTapOutside` as
 *     onResponderRelease. It claims the touch only while the keyboard is up
 *     and only when nothing inside claimed it first (a button, the field, the
 *     body), so with the keyboard down the card behaves as before. The card
 *     stays a plain View with the backdrop as its sibling behind it
 *     (sheet-backdrop-guard.test.ts): VoiceOver still reaches every control.
 *
 * One per sheet opening (the sheets remount their content per opening).
 */
export function useSheetKeyboard() {
  // Made once per opening. The body is held by its callback ref in a plain
  // variable: nothing renders from it, only the revealer's scroll reads it.
  const [sheet] = React.useState(() => {
    let body: ScrollView | null = null;
    return {
      revealer: createFieldRevealer((y) => body?.scrollTo({ y, animated: true })),
      attachBody: (node: ScrollView | null) => {
        body = node;
      },
    };
  });
  const { revealer } = sheet;

  React.useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => revealer.keyboardShown());
    return () => sub.remove();
  }, [revealer]);

  const handlers = React.useMemo(
    () => ({
      onBodyScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => revealer.scrolled(e.nativeEvent.contentOffset.y),
      onBodyLayout: (e: LayoutChangeEvent) => revealer.viewportChanged(e.nativeEvent.layout.height),
      onBodyContentSizeChange: (_w: number, h: number) => revealer.contentChanged(h),
      onNoteBlockLayout: (e: LayoutChangeEvent) =>
        revealer.blockLaid(e.nativeEvent.layout.y, e.nativeEvent.layout.height),
      onNoteLayout: (e: LayoutChangeEvent) => revealer.fieldLaid(e.nativeEvent.layout.y, e.nativeEvent.layout.height),
      onNoteFocus: () => revealer.focus(),
      /** A block holding more than one field (the For sheet's Name and
       *  Email): the field that took focus, where it sits in the block (its
       *  own onLayout), then reveal it. */
      onFieldFocus: (span: { top: number; height: number } | null) => {
        if (span) revealer.fieldLaid(span.top, span.height);
        revealer.focus();
      },
      onNoteBlur: () => revealer.blur(),
      claimTapOutside: () => Keyboard.isVisible(),
      onTapOutside: () => Keyboard.dismiss(),
    }),
    [revealer],
  );
  // The body's callback ref comes back on its own, so the handlers are never
  // taken for a ref (react-hooks/refs follows what is passed to `ref`).
  return [sheet.attachBody, handlers] as const;
}
