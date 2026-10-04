import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Body } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import { MIN_TAP, storefrontLayout } from '@/lib/order-storefront/layout';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * THE STOREFRONT'S SHEET FRAME (phone ordering PO-4): every storefront sheet
 * (the cart, a quantity, Quick view, Sort & filter, Ship from, the delivery
 * site, For, the needed-by) is this shape, so the rules hold in one place:
 *
 *   - the sibling backdrop (sheet-backdrop-guard.test.ts): a container that
 *     keeps VoiceOver inside (accessibilityViewIsModal, Escape closes) and
 *     holds exactly a scrim Pressable named "Close" BEHIND a plain View card,
 *     so every field and button in the card is its own VoiceOver element and
 *     the body can scroll;
 *   - inside a KeyboardAvoidingView, never taller than the space the keyboard
 *     leaves (measured), below the status bar; the body is the part that gives
 *     way and scrolls (exceptionSheetLayout), in points, never percentages;
 *   - at most 640 pt wide, centred (iPad);
 *   - the title is a header capped at the display ceiling; Close is a 44 pt
 *     named button; while `busy` nothing closes it, so an answer is never lost.
 */
export function StorefrontSheet({
  visible,
  title,
  onClose,
  busy = false,
  footer,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  busy?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { c, mode } = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({ windowHeight: height, availableHeight, topInset: insets.top });
  const sheetWidth = storefrontLayout({ width, fontScale }).sheetWidth;

  const requestClose = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={requestClose}
          onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
          style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}
        >
          <Pressable
            onPress={requestClose}
            onAccessibilityTap={requestClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            style={{
              width: sheetWidth,
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              paddingBottom: Math.max(30, insets.bottom + 12),
              gap: 12,
              maxHeight: layout.sheetMaxHeight,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Body
                  size={16}
                  color={c.ink}
                  accessibilityRole="header"
                  maxFontSizeMultiplier={TITLE_CAP}
                  style={{ fontFamily: FONT.display }}
                >
                  {title}
                </Body>
              </View>
              <Pressable
                onPress={requestClose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityState={{ disabled: busy }}
                style={styles.close}
              >
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            <ScrollView
              style={{ maxHeight: layout.sheetMaxHeight, flexShrink: 1 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={{ gap: 12 }}
            >
              {children}
            </ScrollView>
            {footer ? <View style={{ gap: 8 }}>{footer}</View> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The title stops at the display ceiling, like every sheet's title. */
const TITLE_CAP = capTo(16, TYPE_CEILING.display);

const styles = StyleSheet.create({
  close: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
});
