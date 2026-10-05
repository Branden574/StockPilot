import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  exchangeCandidateRows,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURNS_COPY,
  returnLineLabel,
  type ExchangeCandidateRow,
  type ExchangeCandidatesAnswer,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, FieldLabel } from '@/components/ui/text';
import { describeReturnError } from '@/lib/returns-api';
import { ACCENT, capTo, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const INPUT_CAP = capTo(15, TYPE_CEILING.input);

/**
 * The replacement picker on the phone and the iPad (returns RX-2): the
 * returned item's other sizes first, in size order (the items' own variant
 * sizes, never a name guess), then a name or SKU search from two characters,
 * each row with its free stock for the quantity asked ("Available: 14" or
 * "Short: 0 available, 1 needed."). The rows are radio buttons with their
 * state and availability in their label. Online only: offline nothing is
 * asked and the list says it needs a connection.
 */
export function ReplacementPickerList({
  load,
  needed,
  selectedItemId,
  onSelect,
  label,
  online,
  disabled = false,
}: {
  load: (q: string) => Promise<ExchangeCandidatesAnswer>;
  needed: number;
  selectedItemId: string | null;
  onSelect: (row: ExchangeCandidateRow, label: string) => void;
  /** The returned line it is for ("Walk New Hire Shirt, M"). */
  label: string;
  online: boolean;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [q, setQ] = React.useState('');
  const [answer, setAnswer] = React.useState<ExchangeCandidatesAnswer | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);

  React.useEffect(() => {
    if (!online) return;
    let live = true;
    const term = q.trim();
    const t = setTimeout(
      () => {
        setLoading(true);
        loadRef
          .current(term.length >= 2 ? term : '')
          .then((a) => {
            if (!live) return;
            setAnswer(a);
            setError(null);
          })
          .catch((e: unknown) => {
            if (live) setError(describeReturnError(e));
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      term.length >= 2 ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, online]);

  const rows = answer ? exchangeCandidateRows(answer, needed) : { siblings: [], matches: [] };
  const off = disabled || !online;

  const renderRow = (row: ExchangeCandidateRow) => {
    const rowLabel = returnLineLabel(row.name, row.variantSize);
    const checked = selectedItemId === row.itemId;
    const same = row.isReturnedItem ? ` (${RETURNS_COPY.replacementSameAsReturned})` : '';
    return (
      <Pressable
        key={row.itemId}
        disabled={off}
        onPress={() => onSelect(row, rowLabel)}
        accessibilityRole="radio"
        accessibilityLabel={`${rowLabel}${same}. ${row.availability}`}
        accessibilityState={{ checked, disabled: off }}
        style={[
          styles.row,
          { borderColor: checked ? c.ink : c.hair, backgroundColor: checked ? c.paper2 : 'transparent', minHeight: MIN_TAP },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14} color={c.ink} numberOfLines={2}>
            {rowLabel}
            {same}
          </Body>
          {row.sku ? (
            <Body size={12} muted>
              {row.sku}
            </Body>
          ) : null}
        </View>
        <Body size={12.5} color={row.short ? ACCENT.crit : c.ink3}>
          {row.availability}
        </Body>
      </Pressable>
    );
  };

  return (
    <View style={{ gap: 8 }}>
      <FieldLabel>{RETURNS_COPY.replacementSiblings.toUpperCase()}</FieldLabel>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.replacementSiblings} for ${label}`} style={{ gap: 6 }}>
        {rows.siblings.map(renderRow)}
        {!loading && online && answer && rows.siblings.length === 0 ? (
          <Body size={12.5} muted>
            {RETURNS_COPY.replacementNoMatches}
          </Body>
        ) : null}
      </View>

      <FieldLabel>{RETURNS_COPY.replacementOtherItems.toUpperCase()}</FieldLabel>
      <TextInput
        value={q}
        onChangeText={setQ}
        editable={!off}
        maxLength={80}
        placeholder={RETURNS_COPY.replacementSearchPlaceholder}
        placeholderTextColor={c.ink4}
        accessibilityLabel={`${RETURNS_COPY.replacementSearchPlaceholder} for ${label}`}
        maxFontSizeMultiplier={INPUT_CAP}
        autoCorrect={false}
        autoCapitalize="none"
        style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
      />
      {q.trim().length > 0 && q.trim().length < 2 ? (
        <Body size={12.5} muted>
          {RETURNS_COPY.replacementSearchHint}
        </Body>
      ) : null}
      {q.trim().length >= 2 ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.replacementOtherItems} for ${label}`} style={{ gap: 6 }}>
          {rows.matches.map(renderRow)}
          {!loading && answer && rows.matches.length === 0 ? (
            <Body size={12.5} muted>
              {RETURNS_COPY.replacementNoMatches}
            </Body>
          ) : null}
        </View>
      ) : null}

      {loading ? <ActivityIndicator color={c.ink4} /> : null}
      {!online ? (
        <Body size={12.5} muted>
          {READINESS_NEEDS_CONNECTION_COPY}
        </Body>
      ) : null}
      {error ? (
        <Body size={12.5} color={ACCENT.crit} accessibilityRole="alert">
          {error}
        </Body>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
