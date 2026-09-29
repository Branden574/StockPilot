import { Check, X } from 'lucide-react-native';
import * as React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  BOOK_REPORT_ALL_CATEGORIES,
  BOOK_REPORT_ALL_WAREHOUSES,
  BOOK_REPORT_NO_CATEGORY,
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

import {
  OptionRow,
  OptionsProblem,
  SHEET_MIN_TAP,
  Section,
  sheetStyles,
} from '@/components/book-order-sheet-parts';
import { Button } from '@/components/ui/button';
import { Body, Mono } from '@/components/ui/text';
import {
  applyBookReportDraft,
  bookReportDraftProblems,
  resetBookReportDraft,
  statusGroupLabel,
  toggleStatusGroup,
} from '@/lib/book-order-totals-view';
import { ACCENT, FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Book Order Totals filters (plan 9.2, and plan 5 of the charter and dates
 * work): status groups (the organization's own words), the warehouse (follow
 * my warehouse view, all, or one), the category (all, none or one) and the
 * sort. The charter and the dates have their own sheets (the Charter and
 * Orders placed chips open them), so this sheet never changes them. Nothing
 * applies until Apply, which goes back to page 1. Reset returns these four
 * controls to their defaults (and following the warehouse view); Clear
 * filters on the report resets everything.
 *
 * The warehouse and category lists come from the options route: the places
 * and categories that occur in the caller's own eligible order lines,
 * whatever their status. If they could not be loaded, those two sections say
 * so with Retry; statuses and sort still work.
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
  // Only the status can be refused here: the dates are the dates sheet's.
  const problems = bookReportDraftProblems(draft);
  const valid = problems.status === null;

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
    if (!valid) return;
    onApply(applyBookReportDraft(draft));
  }

  const viewLabel =
    activeWarehouseId && activeWarehouseName
      ? `Your warehouse view (${activeWarehouseName})`
      : `Your warehouse view (${BOOK_REPORT_ALL_WAREHOUSES})`;

  // accessibilityViewIsModal keeps VoiceOver inside the open sheet;
  // onAccessibilityTap makes a VoiceOver double-tap on the scrim close it
  // directly (iOS otherwise taps the scrim's centre, which the card covers);
  // the two-finger scrub closes it too.
  return (
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
              onPress={() =>
                setDraft((d) => ({ ...d, warehouse: 'default', warehouseFromView: false }))
              }
            />
            <OptionRow
              kind="radio"
              label={BOOK_REPORT_ALL_WAREHOUSES}
              selected={draft.warehouse === 'all'}
              onPress={() =>
                setDraft((d) => ({ ...d, warehouse: 'all', warehouseFromView: false }))
              }
            />
            {warehouses.map((w) => (
              <OptionRow
                key={w.id}
                kind="radio"
                label={bookReportWarehouseOptionLabel(w)}
                selected={draft.warehouse === w.id}
                onPress={() =>
                  setDraft((d) => ({ ...d, warehouse: w.id, warehouseFromView: false }))
                }
              />
            ))}
            {unlistedWarehouse ? (
              <OptionRow
                kind="radio"
                label={echoWarehouseName ?? 'Chosen warehouse'}
                selected={draft.warehouse === unlistedWarehouse}
                onPress={() =>
                  setDraft((d) => ({
                    ...d,
                    warehouse: unlistedWarehouse,
                    warehouseFromView: false,
                  }))
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
            onPress={() => setDraft(resetBookReportDraft(draft))}
            style={{ flex: 1, minHeight: SHEET_MIN_TAP }}
          >
            Reset
          </Button>
          <Button
            onPress={apply}
            disabled={!valid}
            style={{ flex: 1, minHeight: SHEET_MIN_TAP }}
            leading={<Check size={18} color={c.paper} strokeWidth={1.6} />}
          >
            Apply
          </Button>
        </View>
      </View>
    </View>
  );
}

/** The shared sheet frame (container, card, header, close button, footer). */
const styles = sheetStyles;
