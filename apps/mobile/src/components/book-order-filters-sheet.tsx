import { Check, X } from 'lucide-react-native';
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
  BOOK_REPORT_ALL_CATEGORIES,
  BOOK_REPORT_ALL_WAREHOUSES,
  BOOK_REPORT_NO_CATEGORY,
  BOOK_REPORT_OPTIONS_ERROR,
  BOOK_REPORT_RANGES,
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_SORTS,
  BOOK_REPORT_SORT_LABELS,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  bookReportCategoryOptionLabel,
  bookReportInProgressDetail,
  bookReportWarehouseOptionLabel,
  type BookOrderOptionsResponse,
  type BookReportQuery,
  type OrderStatusKey,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Body, Eyebrow, FieldLabel, Mono } from '@/components/ui/text';
import {
  applyBookReportDraft,
  bookReportDraftIsValid,
  bookReportDraftProblems,
  resetBookReportDraft,
  statusGroupLabel,
  toggleStatusGroup,
} from '@/lib/book-order-totals-view';
import { ACCENT, FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/** Every row in the sheet is at least this tall (a finger, and VoiceOver's
 *  outline, get a full target). */
const MIN_TAP = 44;

/**
 * Book Order Totals filters (plan 9.2): date presets with a custom YYYY-MM-DD
 * range checked by core, status groups (the organization's own words), the
 * warehouse (follow my warehouse view, all, or one), the category (all, none
 * or one) and the sort. Nothing applies until Apply, which goes back to page
 * 1. Reset returns every default (and following the warehouse view).
 *
 * The warehouse and category lists come from the options route: the places
 * and categories that occur in the caller's own eligible order lines,
 * whatever their status. If they could not be loaded, those two sections say
 * so with Retry; dates, statuses and sort still work.
 *
 * Built the sibling-backdrop way (sheet-backdrop-guard.test.ts): the scrim is
 * a childless "Close" button BEHIND a plain-View card, so every field and
 * button is its own VoiceOver element and the list scrolls.
 */
export function BookOrderFiltersSheet(props: {
  visible: boolean;
  onClose: () => void;
  value: BookReportQuery;
  onApply: (next: BookReportQuery) => void;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  options: BookOrderOptionsResponse | null;
  optionsFailed: boolean;
  onRetryOptions: () => void;
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
  /** Names for a chosen id the options do not list (a link's warehouse). */
  echoWarehouseName: string | null;
  echoCategoryName: string | null;
}) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      {/* Remounted per open: every session starts from what is applied. */}
      <FiltersContent key={String(props.visible)} {...props} />
    </Modal>
  );
}

function FiltersContent({
  onClose,
  value,
  onApply,
  statusLabels,
  options,
  optionsFailed,
  onRetryOptions,
  activeWarehouseId,
  activeWarehouseName,
  echoWarehouseName,
  echoCategoryName,
}: React.ComponentProps<typeof BookOrderFiltersSheet>) {
  const { c, mode } = useTheme();
  const [draft, setDraft] = React.useState<BookReportQuery>(() => ({
    ...value,
    statusGroups: [...value.statusGroups],
  }));
  const [touchedDates, setTouchedDates] = React.useState(false);
  const problems = bookReportDraftProblems(draft);
  const valid = bookReportDraftIsValid(draft);

  const warehouses = options?.warehouses ?? [];
  const categories = options?.categories ?? [];
  // The APPLIED warehouse or category when the lists do not carry it (a
  // link named it, or the lists could not be loaded): still offered, so it
  // can be chosen again after trying another.
  const unlistedWarehouse =
    value.warehouse !== 'default' &&
    value.warehouse !== 'all' &&
    !warehouses.some((w) => w.id === value.warehouse)
      ? value.warehouse
      : null;
  const unlistedCategory =
    value.category !== 'all' &&
    value.category !== 'none' &&
    !categories.some((x) => x.id === value.category)
      ? value.category
      : null;

  function apply() {
    if (!valid) {
      setTouchedDates(true);
      return;
    }
    onApply(applyBookReportDraft(draft));
  }

  const viewLabel =
    activeWarehouseId && activeWarehouseName
      ? `Your warehouse view (${activeWarehouseName})`
      : `Your warehouse view (${BOOK_REPORT_ALL_WAREHOUSES})`;

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
              FILTERS
            </Mono>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close filters"
              style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
            >
              <X size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 22 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Section label="ORDERS PLACED DURING">
              {BOOK_REPORT_RANGES.map((r) => (
                <OptionRow
                  key={r}
                  kind="radio"
                  label={BOOK_REPORT_RANGE_LABELS[r]}
                  selected={draft.range === r}
                  onPress={() => setDraft((d) => ({ ...d, range: r }))}
                />
              ))}
              {draft.range === 'custom' ? (
                <View style={styles.dates}>
                  <DateField
                    label="FROM"
                    value={draft.from ?? ''}
                    problem={touchedDates ? problems.from : null}
                    onChange={(v) => setDraft((d) => ({ ...d, from: v.trim() || null }))}
                    onBlur={() => setTouchedDates(true)}
                  />
                  <DateField
                    label="TO"
                    value={draft.to ?? ''}
                    problem={touchedDates ? problems.to : null}
                    onChange={(v) => setDraft((d) => ({ ...d, to: v.trim() || null }))}
                    onBlur={() => setTouchedDates(true)}
                  />
                </View>
              ) : null}
            </Section>

            <Section label="STATUS">
              {BOOK_REPORT_STATUS_GROUP_KEYS.map((g) => (
                <OptionRow
                  key={g}
                  kind="check"
                  label={statusGroupLabel(g, statusLabels)}
                  detail={g === 'in_progress' ? bookReportInProgressDetail(statusLabels) : null}
                  selected={draft.statusGroups.includes(g)}
                  onPress={() =>
                    setDraft((d) => ({ ...d, statusGroups: toggleStatusGroup(d.statusGroups, g) }))
                  }
                />
              ))}
              {problems.status ? (
                <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
                  {problems.status}
                </Body>
              ) : null}
            </Section>

            <Section label="WAREHOUSE">
              <OptionRow
                kind="radio"
                label={viewLabel}
                selected={draft.warehouse === 'default'}
                onPress={() => setDraft((d) => ({ ...d, warehouse: 'default', warehouseFromView: false }))}
              />
              <OptionRow
                kind="radio"
                label={BOOK_REPORT_ALL_WAREHOUSES}
                selected={draft.warehouse === 'all'}
                onPress={() => setDraft((d) => ({ ...d, warehouse: 'all', warehouseFromView: false }))}
              />
              {warehouses.map((w) => (
                <OptionRow
                  key={w.id}
                  kind="radio"
                  label={bookReportWarehouseOptionLabel(w)}
                  selected={draft.warehouse === w.id}
                  onPress={() => setDraft((d) => ({ ...d, warehouse: w.id, warehouseFromView: false }))}
                />
              ))}
              {unlistedWarehouse ? (
                <OptionRow
                  kind="radio"
                  label={echoWarehouseName ?? 'Chosen warehouse'}
                  selected={draft.warehouse === unlistedWarehouse}
                  onPress={() =>
                    setDraft((d) => ({ ...d, warehouse: unlistedWarehouse, warehouseFromView: false }))
                  }
                />
              ) : null}
              {optionsFailed ? <OptionsProblem onRetry={onRetryOptions} /> : null}
            </Section>

            <Section label="CATEGORY">
              <OptionRow
                kind="radio"
                label={BOOK_REPORT_ALL_CATEGORIES}
                selected={draft.category === 'all'}
                onPress={() => setDraft((d) => ({ ...d, category: 'all' }))}
              />
              {options?.uncategorized || draft.category === 'none' ? (
                <OptionRow
                  kind="radio"
                  label={BOOK_REPORT_NO_CATEGORY}
                  selected={draft.category === 'none'}
                  onPress={() => setDraft((d) => ({ ...d, category: 'none' }))}
                />
              ) : null}
              {categories.map((cat) => (
                <OptionRow
                  key={cat.id}
                  kind="radio"
                  label={bookReportCategoryOptionLabel(cat)}
                  selected={draft.category === cat.id}
                  onPress={() => setDraft((d) => ({ ...d, category: cat.id }))}
                />
              ))}
              {unlistedCategory ? (
                <OptionRow
                  kind="radio"
                  label={echoCategoryName ?? 'Chosen category'}
                  selected={draft.category === unlistedCategory}
                  onPress={() => setDraft((d) => ({ ...d, category: unlistedCategory }))}
                />
              ) : null}
              {optionsFailed ? <OptionsProblem onRetry={onRetryOptions} /> : null}
            </Section>

            <Section label="SORT">
              {BOOK_REPORT_SORTS.map((s) => (
                <OptionRow
                  key={s}
                  kind="radio"
                  label={BOOK_REPORT_SORT_LABELS[s]}
                  selected={draft.sort === s}
                  onPress={() => setDraft((d) => ({ ...d, sort: s }))}
                />
              ))}
            </Section>
          </ScrollView>

          <View style={styles.footer}>
            <Button
              variant="outline"
              onPress={() => {
                setTouchedDates(false);
                setDraft(resetBookReportDraft(value));
              }}
              style={{ flex: 1, minHeight: MIN_TAP }}
            >
              Reset
            </Button>
            <Button
              onPress={apply}
              disabled={!valid && touchedDates}
              style={{ flex: 1, minHeight: MIN_TAP }}
              leading={<Check size={18} color={c.paper} strokeWidth={1.6} />}
            >
              Apply
            </Button>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View>
      <Eyebrow accessibilityRole="header">{label}</Eyebrow>
      <View style={{ marginTop: 8, gap: 2 }}>{children}</View>
    </View>
  );
}

function OptionRow({
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
        {kind === 'check' && selected ? <Check size={13} color={c.paper} strokeWidth={2.2} /> : null}
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

function DateField({
  label,
  value,
  problem,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  problem: string | null;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 140, gap: 6 }}>
      <FieldLabel>{label}</FieldLabel>
      <TextInput
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={c.ink4}
        accessibilityLabel={`${label === 'FROM' ? 'First date' : 'Last date'}, written year, month, day`}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        maxFontSizeMultiplier={capTo(15, TYPE_CEILING.input)}
        style={[
          styles.input,
          {
            color: c.ink,
            borderColor: problem ? ACCENT.crit : c.hair,
            backgroundColor: c.paper,
            fontFamily: FONT.mono,
          },
        ]}
      />
      {problem ? (
        <Body size={12.5} color={ACCENT.crit} accessibilityRole="alert">
          {problem}
        </Body>
      ) : null}
    </View>
  );
}

function OptionsProblem({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={{ gap: 8, marginTop: 6 }}>
      <Body size={13} muted accessibilityRole="alert">
        {BOOK_REPORT_OPTIONS_ERROR.replace(/\s*Retry$/, '')}
      </Body>
      <Button size="sm" variant="outline" onPress={onRetry} style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}>
        Retry
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
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
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  option: {
    minHeight: MIN_TAP,
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
  dates: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  input: {
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  footer: {
    paddingHorizontal: 22,
    paddingTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
});
