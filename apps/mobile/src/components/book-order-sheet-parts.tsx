import { Check } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BOOK_REPORT_OPTIONS_ERROR, BOOK_REPORT_UI } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Body, Eyebrow } from '@/components/ui/text';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The pieces the three Book Order Totals sheets share (Charter, Orders
 * placed, Filters): a labelled section, a radio or check row, and the
 * "lists could not be loaded" block with Retry. Each sheet still writes its
 * own Modal, scrim and card (the sibling-backdrop shape the sheet tests pin
 * per file); only the rows inside are shared, so the three read and behave
 * alike.
 */

/** Every row and button in the sheets is at least this tall (a finger, and
 *  VoiceOver's outline, get a full target). */
export const SHEET_MIN_TAP = 44;

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View>
      <Eyebrow accessibilityRole="header">{label}</Eyebrow>
      <View style={{ marginTop: 8, gap: 2 }}>{children}</View>
    </View>
  );
}

/** One choice: a radio (one of a list) or a check (any of a list), 44 pt
 *  tall, announced with its role and state. */
export function OptionRow({
  kind,
  label,
  detail,
  selected,
  onPress,
}: {
  kind: 'radio' | 'check';
  label: string;
  detail?: string | null;
  selected: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={kind === 'radio' ? 'radio' : 'checkbox'}
      accessibilityState={kind === 'radio' ? { selected } : { checked: selected }}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      style={({ pressed }) => [styles.option, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View
        style={[
          kind === 'radio' ? styles.radio : styles.check,
          {
            borderColor: selected ? c.ink : c.ink5,
            backgroundColor: kind === 'check' && selected ? c.ink : 'transparent',
          },
        ]}
      >
        {kind === 'radio' && selected ? (
          <View style={[styles.radioFill, { backgroundColor: c.ink }]} />
        ) : null}
        {kind === 'check' && selected ? (
          <Check size={13} color={c.paper} strokeWidth={2.2} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {label}
        </Body>
        {detail ? (
          <Body size={12.5} muted>
            {detail}
          </Body>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The charter, warehouse and category lists could not be loaded: core's
 *  words and Retry. The applied choice is still offered by name. */
export function OptionsProblem({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={{ gap: 8, marginTop: 6 }}>
      <Body size={13} muted accessibilityRole="alert">
        {BOOK_REPORT_OPTIONS_ERROR.replace(/\s*Retry$/, '')}
      </Body>
      <Button
        size="sm"
        variant="outline"
        onPress={onRetry}
        style={{ alignSelf: 'flex-start', minHeight: SHEET_MIN_TAP }}
      >
        {BOOK_REPORT_UI.retry}
      </Button>
    </View>
  );
}

/** The sheets' shared frame styles (each sheet still draws its own). */
export const sheetStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'flex-end' },
  card: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: '90%',
  },
  header: {
    paddingHorizontal: 22,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  iconButton: {
    minWidth: SHEET_MIN_TAP,
    minHeight: SHEET_MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 22,
    paddingTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
});

const styles = StyleSheet.create({
  option: {
    minHeight: SHEET_MIN_TAP,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioFill: { width: 10, height: 10, borderRadius: 5 },
  check: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
