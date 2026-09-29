import { Search, X } from 'lucide-react-native';
import * as React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  BOOK_REPORT_CHARTER_HINT,
  BOOK_REPORT_UI,
  type BookOrderOptionsResponse,
  type BookReportCharterEcho,
} from '@stockpilot/core';

import {
  OptionRow,
  OptionsProblem,
  SHEET_MIN_TAP,
  sheetStyles,
} from '@/components/book-order-sheet-parts';
import { Body, Mono } from '@/components/ui/text';
import {
  BOOK_REPORT_CHARTER_SEARCH_OVER,
  bookReportCharterChoices,
  filterBookReportCharterChoices,
} from '@/lib/book-order-totals-view';
import { FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Charter (plan 5): the charter each ORDER was placed for (its delivery
 * site), never the charter that owns a book.
 *
 *   - One radio row each: All charters, every charter the reader may report
 *     on (from the options route; the server decides which), an applied
 *     charter the lists do not carry (by the answer's name), and No charter
 *     (pickup orders and orders placed without one) only when the reader's
 *     book orders include some, or it is applied.
 *   - A tap applies and closes (page 1), as the web select does; the X
 *     closes with no change.
 *   - A search field above the rows only past 12 rows.
 *   - Lists that could not be loaded say so with Retry; All charters and the
 *     applied choice are still offered by name.
 *
 * The list is never an authority: the server accepts a charter only if the
 * reader may report on it, and a refused one is reset with the report's
 * "filters were reset" notice.
 *
 * Built the sibling-backdrop way (sheet-backdrop-guard.test.ts), like the
 * other two report sheets.
 */
export function BookOrderCharterSheet(props: {
  visible: boolean;
  onClose: () => void;
  /** The applied charter: 'all', 'none' or an id. */
  value: string;
  onChoose: (charter: string) => void;
  options: Pick<BookOrderOptionsResponse, 'charters' | 'noCharter'> | null;
  optionsFailed: boolean;
  onRetryOptions: () => void;
  /** Labels by charter id (core's, with the tie-break for alike names). */
  labels: ReadonlyMap<string, string>;
  /** The on-screen answer's charter, to name an applied id the lists lack. */
  echo: BookReportCharterEcho | null;
}) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      {/* Remounted per open: the search starts empty each time. */}
      <CharterContent key={String(props.visible)} {...props} />
    </Modal>
  );
}

function CharterContent({
  onClose,
  value,
  onChoose,
  options,
  optionsFailed,
  onRetryOptions,
  labels,
  echo,
}: React.ComponentProps<typeof BookOrderCharterSheet>) {
  const { c, mode } = useTheme();
  const [text, setText] = React.useState('');
  const choices = bookReportCharterChoices({ current: value, options, labels, echo });
  const searchable = choices.length > BOOK_REPORT_CHARTER_SEARCH_OVER;
  const shown = searchable ? filterBookReportCharterChoices(choices, text, value) : choices;
  const loading = !options && !optionsFailed;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {/* accessibilityViewIsModal keeps VoiceOver inside the open sheet;
          onAccessibilityTap makes a VoiceOver double-tap on the scrim close
          it directly (iOS otherwise taps the scrim's centre, which the card
          covers); the two-finger scrub closes it too. */}
      <View style={styles.container} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <View style={[styles.card, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.header}>
            <Mono
              size={13}
              tracking={0.08}
              color={c.ink}
              maxFontSizeMultiplier={capTo(13, TYPE_CEILING.control)}
              style={{ fontFamily: FONT.display, flexShrink: 1 }}
              accessibilityRole="header"
            >
              CHARTER
            </Mono>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close charter choices"
              style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
            >
              <X size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 2 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Body size={13} muted style={{ marginBottom: 8 }}>
              {BOOK_REPORT_CHARTER_HINT}
            </Body>

            {searchable ? (
              <View style={[styles.searchBox, { backgroundColor: c.paper, borderColor: c.hair }]}>
                <Search size={16} color={c.ink4} strokeWidth={1.4} />
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder="Charter name or code"
                  placeholderTextColor={c.ink4}
                  accessibilityLabel="Search charters"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  maxFontSizeMultiplier={capTo(14.5, TYPE_CEILING.input)}
                  style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
                />
              </View>
            ) : null}

            {shown.map((choice) => (
              <OptionRow
                key={choice.value}
                kind="radio"
                label={choice.label}
                detail={choice.detail}
                selected={choice.value === value.toLowerCase()}
                onPress={() => onChoose(choice.value)}
              />
            ))}

            {loading ? (
              <Body size={13} muted accessibilityLiveRegion="polite" style={{ marginTop: 6 }}>
                {BOOK_REPORT_UI.listsLoading}
              </Body>
            ) : null}
            {optionsFailed ? <OptionsProblem onRetry={onRetryOptions} /> : null}
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = {
  ...sheetStyles,
  ...StyleSheet.create({
    searchBox: {
      minHeight: SHEET_MIN_TAP,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
    },
    searchInput: { flex: 1, minWidth: 0, fontSize: 14.5, minHeight: SHEET_MIN_TAP },
  }),
};
