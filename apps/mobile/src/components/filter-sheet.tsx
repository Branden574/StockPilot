import { Check, SlidersHorizontal, X } from 'lucide-react-native';
import * as React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { CheckboxMark } from '@/components/ui/checkbox';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

export interface FilterOption {
  id: string;
  name: string;
}

export type StockStatus = 'all' | 'low' | 'out' | 'archived' | 'expected';
export type SortKey =
  | 'updated_desc'
  | 'name_asc'
  | 'name_desc'
  | 'qty_desc'
  | 'qty_asc';

export const SORT_LABEL: Record<SortKey, string> = {
  updated_desc: 'Recently updated',
  name_asc: 'Name (A → Z)',
  name_desc: 'Name (Z → A)',
  qty_desc: 'On hand (high → low)',
  qty_asc: 'On hand (low → high)',
};

export interface FilterState {
  status: StockStatus;
  sort: SortKey;
  categoryIds: string[];
  locationIds: string[];
  charterIds: string[];
}

export const EMPTY_FILTER_STATE: FilterState = {
  status: 'all',
  sort: 'updated_desc',
  categoryIds: [],
  locationIds: [],
  charterIds: [],
};

export function activeFilterCount(s: FilterState): number {
  return (
    (s.status === 'all' ? 0 : 1)
    + (s.sort === 'updated_desc' ? 0 : 1)
    + s.categoryIds.length
    + s.locationIds.length
    + s.charterIds.length
  );
}

/**
 * The spoken name of the filter button beside the search box (CONFLICTS D29:
 * it was an icon and a bare number, so VoiceOver found an unnamed element, or
 * read "2" with nothing to say what it counted). The sheet it opens is headed
 * FILTERS; the count is the one the button shows.
 */
export function filterButtonLabel(count: number): string {
  return count > 0 ? `Filters, ${count} active` : 'Filters';
}

interface Props {
  visible: boolean;
  onDismiss: () => void;
  state: FilterState;
  onChange: (next: FilterState) => void;
  categories: FilterOption[];
  locations: FilterOption[];
  charters: FilterOption[];
  /** When true, the Charter section prepends a "Generic (any charter)"
   *  sentinel option with id "__generic__" so callers can map it to
   *  charter_id IS NULL. */
  showGenericCharter?: boolean;
}

const GENERIC_CHARTER_ID = '__generic__';
export const FILTER_GENERIC_CHARTER_ID = GENERIC_CHARTER_ID;

export function FilterSheet({
  visible,
  onDismiss,
  state,
  onChange,
  categories,
  locations,
  charters,
  showGenericCharter = true,
}: Props) {
  const { c, mode } = useTheme();
  const { fontScale } = useWindowDimensions();
  const headerStacked = shouldStackRow(fontScale);

  function toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  const charterOptions: FilterOption[] = showGenericCharter
    ? [{ id: GENERIC_CHARTER_ID, name: 'Generic (any charter)' }, ...charters]
    : charters;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      {/*
       * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
       * ancestor claims the touch on press-down and beats the ScrollView's pan
       * recogniser, so the filter list would not scroll until something else
       * took the responder first. This sheet has NO text input, so the "tap
       * the search box first" workaround that masks the bug elsewhere does not
       * exist here — a stuck list is the only symptom. Do not re-nest this
       * card inside the scrim. See add-order-items-sheet.tsx.
       *
       * VoiceOver, as on the app's other sheets (sheet-a11y-structure.test.ts):
       * the container keeps VoiceOver inside the open sheet and the two-finger
       * scrub closes it; the scrim is its own element, so it says what it does
       * ("Close", a button), and a VoiceOver double-tap on it closes directly
       * (onAccessibilityTap) instead of tapping the scrim's centre, which the
       * card covers. It was an unnamed element before.
       */}
      <View style={styles.container} accessibilityViewIsModal onAccessibilityEscape={onDismiss}>
        <Pressable
          onPress={onDismiss}
          onAccessibilityTap={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: c.card,
              paddingTop: Platform.OS === 'ios' ? 10 : 18,
              paddingBottom: Platform.OS === 'ios' ? 28 : 22,
            },
            SHADOW.sheet,
          ]}
        >
          {Platform.OS === 'ios' ? (
            <View style={styles.grabberRow}>
              <View
                style={[
                  styles.grabber,
                  {
                    backgroundColor:
                      mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                  },
                ]}
              />
            </View>
          ) : null}

          {/* Title and action are two non-shrinking mono runs on one
              `space-between` row: at accessibility sizes they meet in the
              middle and CLEAR ALL — the only way to reset the filters — walks
              off the right edge ("FILTERSCLEAR A"). Past the shared threshold
              the action drops to its own line, where it always fits. Neither
              label is capped: both are chrome, but they are also the sheet's
              only labels, and the box fix alone is enough. */}
          <View style={[styles.header, headerStacked && styles.headerStacked]}>
            <View style={styles.headerTitle}>
              <SlidersHorizontal size={16} color={c.ink} strokeWidth={1.6} />
              <Mono
                size={13}
                tracking={0.08}
                accessibilityRole="header"
                style={{ fontFamily: FONT.display, color: c.ink, flexShrink: 1, minWidth: 0 }}
              >
                FILTERS
              </Mono>
            </View>
            {/* A button, in a 44pt frame (it was unnamed as a control, its
                words in the faint ink4 under AA, and its target the 11.5pt
                words plus an 8pt slop, about 30pt). */}
            <Pressable
              onPress={() => onChange(EMPTY_FILTER_STATE)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.clearAll, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Mono size={11.5} tracking={0.06} color={c.ink3}>
                CLEAR ALL
              </Mono>
            </Pressable>
          </View>

          {/* flexShrink (ScrollView's own default, kept) lets the list give
              way when the sheet reaches its 90% ceiling, so the header and
              Apply stay on screen on a small phone or at large text sizes. */}
          <ScrollView
            style={{ maxHeight: 520 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 18, gap: 22 }}
            showsVerticalScrollIndicator={false}
          >
            <Section label="STOCK" choice="radio">
              <RadioRow
                label="All items"
                active={state.status === 'all'}
                onPress={() => onChange({ ...state, status: 'all' })}
              />
              <RadioRow
                label="Low + critical"
                active={state.status === 'low'}
                onPress={() => onChange({ ...state, status: 'low' })}
              />
              <RadioRow
                label="Out of stock"
                active={state.status === 'out'}
                onPress={() => onChange({ ...state, status: 'out' })}
              />
              <RadioRow
                label="Archived"
                active={state.status === 'archived'}
                onPress={() => onChange({ ...state, status: 'archived' })}
              />
              {/* Expected-items visibility (mig 0277): items auto-created from
                  inbound POs are hidden from the default lists until their
                  FIRST receipt. This option flips the list to flagged-only —
                  same radio-swap model as Archived (never combined with
                  low/out: a phantom has no stock to be low or out OF). */}
              <RadioRow
                label="Expected (awaiting first receipt)"
                active={state.status === 'expected'}
                onPress={() => onChange({ ...state, status: 'expected' })}
              />
            </Section>

            <Section label="SORT" choice="radio">
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <RadioRow
                  key={k}
                  label={SORT_LABEL[k]}
                  active={state.sort === k}
                  onPress={() => onChange({ ...state, sort: k })}
                />
              ))}
            </Section>

            {categories.length > 0 && (
              <Section label={`CATEGORY · ${state.categoryIds.length || 'ANY'}`} choice="check">
                {categories.map((opt) => (
                  <CheckRow
                    key={opt.id}
                    label={opt.name}
                    active={state.categoryIds.includes(opt.id)}
                    onPress={() =>
                      onChange({ ...state, categoryIds: toggleIn(state.categoryIds, opt.id) })
                    }
                  />
                ))}
              </Section>
            )}

            {locations.length > 0 && (
              <Section label={`LOCATION · ${state.locationIds.length || 'ANY'}`} choice="check">
                {locations.map((opt) => (
                  <CheckRow
                    key={opt.id}
                    label={opt.name}
                    active={state.locationIds.includes(opt.id)}
                    onPress={() =>
                      onChange({ ...state, locationIds: toggleIn(state.locationIds, opt.id) })
                    }
                  />
                ))}
              </Section>
            )}

            {charterOptions.length > 0 && (
              <Section label={`CHARTER · ${state.charterIds.length || 'ANY'}`} choice="check">
                {charterOptions.map((opt) => (
                  <CheckRow
                    key={opt.id}
                    label={opt.name}
                    active={state.charterIds.includes(opt.id)}
                    onPress={() =>
                      onChange({ ...state, charterIds: toggleIn(state.charterIds, opt.id) })
                    }
                  />
                ))}
              </Section>
            )}
          </ScrollView>

          <View style={{ paddingHorizontal: 22, paddingTop: 12 }}>
            <Button block onPress={onDismiss} leading={<Check size={18} color={c.paper} strokeWidth={1.6} />}>
              Apply
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * One section of the sheet. Its label is a heading for VoiceOver's rotor. The
 * 'radiogroup' role marks a section of radios (STOCK, SORT) as one semantic
 * group; on iOS VoiceOver does not announce the group, and it reads each row
 * as "radio button" with its checked state.
 */
function Section({
  label,
  choice,
  children,
}: {
  label: string;
  choice: 'radio' | 'check';
  children: React.ReactNode;
}) {
  return (
    <View>
      <Eyebrow accessibilityRole="header">{label}</Eyebrow>
      <View
        accessibilityRole={choice === 'radio' ? 'radiogroup' : undefined}
        style={{ marginTop: 8 }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * A STOCK or SORT choice: a radio, announced with its state. The ring was the
 * hairline (1.26:1 on the card in light, 1.13:1 in dark, under the 3:1 a mark
 * needs); it is the checkbox's ink4 edge now (3.33:1 and 3.43:1), and the
 * 22pt ring is the checkbox's size, so radio and checkbox labels share one
 * left edge.
 */
function RadioRow({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      style={({ pressed }) => [optStyles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View
        style={[optStyles.dot, { borderColor: active ? c.ink : c.ink4, backgroundColor: c.card }]}
      >
        {active ? <View style={[optStyles.dotFill, { backgroundColor: c.ink }]} /> : null}
      </View>
      <Body size={15} style={{ flex: 1, fontFamily: FONT.display, color: c.ink }}>
        {label}
      </Body>
    </Pressable>
  );
}

/**
 * A CATEGORY, LOCATION or CHARTER choice: the whole row is the checkbox, so it
 * draws the shared CheckboxMark and carries the role and state itself. Its
 * own hand-drawn box had a hairline edge (under 3:1) and no checkbox role or
 * state, so VoiceOver read the name and nothing else.
 */
function CheckRow({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
      style={({ pressed }) => [optStyles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      <CheckboxMark checked={active} />
      <Body size={15} style={{ flex: 1, fontFamily: FONT.display, color: c.ink }}>
        {label}
      </Body>
    </Pressable>
  );
}

export function FilterButton({
  onPress,
  count,
}: {
  onPress: () => void;
  count: number;
}) {
  const { c } = useTheme();
  const isActive = count > 0;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      // D29: named, and announced as a button (an icon and a number before).
      accessibilityRole="button"
      accessibilityLabel={filterButtonLabel(count)}
      style={({ pressed }) => [
        fbStyles.btn,
        {
          backgroundColor: isActive ? c.ink : 'transparent',
          // The stronger border: a control must not rely on a hairline alone.
          borderColor: isActive ? c.ink : c.hair2,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <SlidersHorizontal
        size={14}
        color={isActive ? c.paper : c.ink}
        strokeWidth={1.7}
      />
      {isActive ? (
        // A count in a 32pt round chip beside the search bar — chrome, and the
        // number is restated in the sheet this button opens.
        <Mono
          size={11}
          tracking={0.04}
          maxFontSizeMultiplier={capTo(11, TYPE_CEILING.chrome)}
          style={{ color: c.paper, fontFamily: FONT.display }}
        >
          {count}
        </Mono>
      ) : null}
    </Pressable>
  );
}

// Convenience component for a clear-all pill below the search bar
export function ActiveFilterPill({
  state,
  onClear,
  lookups,
}: {
  state: FilterState;
  onClear: () => void;
  lookups: {
    categories: Map<string, string>;
    locations: Map<string, string>;
    charters: Map<string, string>;
  };
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const parts: string[] = [];
  if (state.status === 'low') parts.push('Low + critical');
  if (state.status === 'out') parts.push('Out of stock');
  if (state.status === 'archived') parts.push('Archived');
  if (state.status === 'expected') parts.push('Expected');
  if (state.sort !== 'updated_desc') parts.push(SORT_LABEL[state.sort]);
  for (const id of state.categoryIds) {
    const n = lookups.categories.get(id);
    if (n) parts.push(n);
  }
  for (const id of state.locationIds) {
    const n = lookups.locations.get(id);
    if (n) parts.push(n);
  }
  for (const id of state.charterIds) {
    if (id === GENERIC_CHARTER_ID) parts.push('Generic');
    else {
      const n = lookups.charters.get(id);
      if (n) parts.push(n);
    }
  }
  if (parts.length === 0) return null;
  return (
    <Pressable
      onPress={onClear}
      // A tap clears every filter; VoiceOver read the filter names with no
      // sign that they were a control, or what it would do.
      accessibilityRole="button"
      accessibilityHint="Clears all filters"
      style={({ pressed }) => [
        pillStyles.row,
        { borderColor: c.hair2, backgroundColor: c.card, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      {/* NO cap: `parts` splices USER-AUTHORED category, location and charter
          names in beside the built-in status words, and plan §3 keeps content
          scaling — a ceiling here would suppress exactly the segments the user
          named themselves.

          The second line is GATED on the shared stack threshold instead of
          always on: this pill sits under the search bar on both hot lists, so
          an ungated `numberOfLines={2}` doubled the filter bar's height at
          DEFAULT text size for every user. Past the threshold the extra line
          is what stops an accessibility size showing three characters and an
          ellipsis. The X stays put either way.

          Muted ink (ink3): these are the filters in force, information, and
          the faint ink4 held them under AA. */}
      <Text
        numberOfLines={shouldStackRow(fontScale) ? 2 : 1}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: FONT.mono,
          fontSize: 11,
          letterSpacing: 11 * 0.04,
          color: c.ink3,
        }}
      >
        {parts.join(' · ')}
      </Text>
      <X size={12} color={c.ink3} strokeWidth={1.6} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The sheet's VoiceOver container (accessibilityViewIsModal): the scrim and
  // the card, the card anchored at the foot.
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    // On a small phone (iPhone SE: 667pt) or at large text sizes the header,
    // a 520pt list and Apply came to more than the screen, and the top of the
    // sheet, CLEAR ALL with it, went under the status bar. The list now gives
    // way instead.
    maxHeight: '90%',
  },
  grabberRow: {
    alignItems: 'center',
    marginBottom: 10,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 100,
  },
  // CLEAR ALL's 44pt frame sets the row's height, so the row takes no
  // padding of its own above it.
  header: {
    paddingHorizontal: 22,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  // Stacked, CLEAR ALL sits under FILTERS on its own full-width line.
  // `flex-start` keeps its tap target on the label rather than the whole row.
  headerStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
    minWidth: 0,
  },
  // A real frame, not hitSlop: VoiceOver outlines the frame, and hitSlop does
  // not reach past a parent's bounds. minHeight / minWidth, so it still grows.
  clearAll: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    flexShrink: 1,
  },
});

const optStyles = StyleSheet.create({
  // A 44pt row: the whole line is the target.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingVertical: 8,
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotFill: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});

const fbStyles = StyleSheet.create({
  btn: {
    minWidth: 32,
    // minHeight, not height: paired with the cap above, so the capped count
    // still has a box to sit in rather than being sliced by a 32pt frame.
    minHeight: 32,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
});

const pillStyles = StyleSheet.create({
  // A 44pt target, the height of the search box above it (the 11pt line and
  // 8pt of padding made about 30pt). minHeight, so it grows with its words.
  row: {
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
});
