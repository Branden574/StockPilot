import { Download, X } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Body, Display, Mono } from '@/components/ui/text';
import {
  BOOK_REPORT_EXPORT_OFFLINE,
  BOOK_REPORT_EXPORT_PREPARING,
  BOOK_REPORT_EXPORT_SHEET_NOTE,
  BOOK_REPORT_EXPORT_SHEET_TITLE,
  bookReportExportOffer,
  type BookReportExportChoice,
  type BookReportExportChoiceId,
} from '@/lib/book-order-totals-view';
import { ACCENT, FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const MIN_TAP = 44;

/**
 * The iOS export sheet for Book Order Totals (plan 9.5): CSV (data only, no
 * covers), PDF with covers, PDF without covers. Every file holds EVERY book
 * that matches the filters, not the page on screen.
 *
 *   - BEFORE anything is exported, the sheet says when the result has more
 *     books than a PDF carries covers for (core's words, the same line as the
 *     web menu), and disables a format above its ceiling with the counts.
 *   - The screen never shows this sheet on Android (bookReportExportMode):
 *     Android's Share cannot hand over a file, so the web is offered there.
 *
 * Sibling backdrop (sheet-backdrop-guard.test.ts): a childless "Close"
 * scrim behind a plain-View card.
 */
export function BookOrderExportSheet({
  visible,
  onClose,
  totalCount,
  offline,
  busy,
  error,
  onChoose,
}: {
  visible: boolean;
  onClose: () => void;
  /** Books in the on-screen result (the API's totalCount). */
  totalCount: number;
  offline: boolean;
  /** The export being prepared, or null. */
  busy: BookReportExportChoiceId | null;
  /** Why the last export failed, in words, or null. */
  error: string | null;
  onChoose: (choice: BookReportExportChoice) => void;
}) {
  const { c, mode } = useTheme();
  const offer = bookReportExportOffer(totalCount);
  const csv = offer.choices.filter((ch) => ch.format === 'csv');
  const pdf = offer.choices.filter((ch) => ch.format === 'pdf');
  const close = busy ? () => undefined : onClose;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={styles.container} accessibilityViewIsModal onAccessibilityEscape={close}>
        <Pressable
          onPress={close}
          onAccessibilityTap={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <View style={[styles.card, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.header}>
            <Display size={22} style={{ flexShrink: 1 }} accessibilityRole="header">
              {BOOK_REPORT_EXPORT_SHEET_TITLE}
            </Display>
            <Pressable
              onPress={close}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityLabel="Close export"
              accessibilityState={{ disabled: busy !== null }}
              style={({ pressed }) => [styles.iconButton, { opacity: busy ? 0.4 : pressed ? 0.6 : 1 }]}
            >
              <X size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>
          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 12, gap: 12 }}
          >
            <Body size={13.5} muted>
              {BOOK_REPORT_EXPORT_SHEET_NOTE}
            </Body>
            {offline ? (
              <Body size={13.5} color={ACCENT.warn} accessibilityRole="alert">
                {BOOK_REPORT_EXPORT_OFFLINE}
              </Body>
            ) : null}

            {csv.map((choice) => (
              <ChoiceButton
                key={choice.id}
                choice={choice}
                busy={busy}
                offline={offline}
                onChoose={onChoose}
              />
            ))}
            {pdf.map((choice) => (
              <ChoiceButton
                key={choice.id}
                choice={choice}
                busy={busy}
                offline={offline}
                onChoose={onChoose}
              />
            ))}
            {offer.coverCapNote ? (
              <Body size={13} muted>
                {offer.coverCapNote}
              </Body>
            ) : null}

            {busy ? (
              <View style={styles.busy} accessibilityLiveRegion="polite">
                <ActivityIndicator color={c.ink} />
                <Body size={13.5}>{BOOK_REPORT_EXPORT_PREPARING}</Body>
              </View>
            ) : null}
            {error ? (
              <Body size={13.5} color={ACCENT.crit} accessibilityRole="alert">
                {error}
              </Body>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ChoiceButton({
  choice,
  busy,
  offline,
  onChoose,
}: {
  choice: BookReportExportChoice;
  busy: BookReportExportChoiceId | null;
  offline: boolean;
  onChoose: (choice: BookReportExportChoice) => void;
}) {
  const { c } = useTheme();
  const disabled = busy !== null || offline || choice.disabledReason !== null;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        onPress={disabled ? undefined : () => onChoose(choice)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={choice.label}
        accessibilityHint={choice.disabledReason ?? 'Downloads the file, then opens the share sheet'}
        accessibilityState={{ disabled, busy: busy === choice.id }}
        style={({ pressed }) => [
          styles.choice,
          { borderColor: c.hair, backgroundColor: c.paper, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        ]}
      >
        <Download size={18} color={c.ink} strokeWidth={1.6} />
        <Mono
          size={14}
          tracking={0.01}
          color={c.ink}
          maxFontSizeMultiplier={capTo(14, TYPE_CEILING.control)}
          style={{ fontFamily: FONT.display, flexShrink: 1 }}
        >
          {choice.label}
        </Mono>
      </Pressable>
      {choice.disabledReason ? (
        <Body size={12.5} muted>
          {choice.disabledReason}
        </Body>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'flex-end' },
  card: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 14,
    paddingBottom: 32,
    maxHeight: '88%',
  },
  header: {
    paddingHorizontal: 22,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  iconButton: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choice: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
