import * as React from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import { createFieldsRevealer } from './sheet-fields-reveal';

/**
 * The keyboard in a bottom sheet with SEVERAL fields (the F2-5 draft sheet:
 * one quantity per short item): lib/use-sheet-keyboard.ts's rules, keyed by
 * field.
 *
 *   - The focused field's row is scrolled back into view whenever the body's
 *     window changes under it, once the keyboard has shown, and on focus
 *     (lib/sheet-fields-reveal.ts over lib/sheet-field-reveal.ts). Wire:
 *     `const [attachBody, kb] = useSheetKeyboardFields()`; the body ScrollView
 *     takes `ref={attachBody}`, `onBodyScroll` (with scrollEventThrottle 16),
 *     `onBodyLayout` and `onBodyContentSizeChange`; each row, directly in the
 *     body, takes `onLayout={(e) => kb.onRowLayout(key, e)}`; its TextInput,
 *     directly in the row, takes `onLayout={(e) => kb.onFieldLayout(key, e)}`,
 *     `onFocus={() => kb.onFieldFocus(key)}` and
 *     `onBlur={() => kb.onFieldBlur(key)}`.
 *   - A drag on the body puts the keyboard away (keyboardDismissMode
 *     "on-drag", with keyboardShouldPersistTaps "handled" so a tap on a
 *     checkbox or Draft still lands the first time).
 *   - A tap on the card outside the body puts it away: the card takes
 *     `claimTapOutside` as onStartShouldSetResponder and `onTapOutside` as
 *     onResponderRelease; it claims the touch only while the keyboard is up
 *     and only when nothing inside claimed it first. The card stays a plain
 *     View with the backdrop as its sibling (sheet-backdrop-guard.test.ts).
 *
 * One per sheet opening (the sheet remounts its content per opening).
 */
export function useSheetKeyboardFields() {
  const [sheet] = React.useState(() => {
    let body: ScrollView | null = null;
    return {
      revealer: createFieldsRevealer((y) => body?.scrollTo({ y, animated: true })),
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
      onRowLayout: (key: string, e: LayoutChangeEvent) =>
        revealer.blockLaid(key, e.nativeEvent.layout.y, e.nativeEvent.layout.height),
      onFieldLayout: (key: string, e: LayoutChangeEvent) =>
        revealer.fieldLaid(key, e.nativeEvent.layout.y, e.nativeEvent.layout.height),
      onFieldFocus: (key: string) => revealer.focus(key),
      onFieldBlur: (key: string) => revealer.blur(key),
      claimTapOutside: () => Keyboard.isVisible(),
      onTapOutside: () => Keyboard.dismiss(),
    }),
    [revealer],
  );
  // The body's callback ref comes back on its own, so the handlers are never
  // taken for a ref (react-hooks/refs follows what is passed to `ref`).
  return [sheet.attachBody, handlers] as const;
}
