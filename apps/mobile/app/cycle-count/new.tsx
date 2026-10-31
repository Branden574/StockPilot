import { useRouter } from 'expo-router';
import { ArrowLeft, Search, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { cycleCountStartedMessage } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { CheckboxMark } from '@/components/ui/checkbox';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import {
  countPickerPlan,
  mergeRows,
  pickFromRow,
  type CountPickerRow,
  type CountPickerTab,
} from '@/lib/count-picker';
import { supabase } from '@/lib/supabase';
import {
  countSelection,
  useCountPicks,
  useIsPicked,
  type CountPick,
} from '@/lib/use-count-selection';
import { FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

interface StartResult {
  id: string;
  lineCount: number;
  skipped: number;
}

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * Start a count from a selection (redesign package P5.9a): the per-mode
 * palette, the picker's Inventory / Books tabs as the reference's segmented
 * switch, each picker row a CheckboxMark row (the shared phone checkbox,
 * P2.5b) on the accent wash while picked, every control a 44pt target, and
 * Start count the ink button that commits the count. Every word, query,
 * gate and the shared countSelection store are unchanged.
 */
export default function NewCycleCount() {
  const router = useRouter();
  const { c } = useTheme();
  const picks = useCountPicks();
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const books = picks.filter((p) => p.itemType === 'book');
  const products = picks.filter((p) => p.itemType !== 'book');

  async function start() {
    if (picks.length === 0 || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    try {
      const res = await api<StartResult>('/api/v1/cycle-counts', {
        method: 'POST',
        body: {
          scope: 'selection',
          itemIds: picks.map((p) => p.id),
          notes: notes.trim() || null,
        },
      });
      countSelection.clear();
      router.replace({ pathname: '/cycle-count/[id]', params: { id: res.id } });
      // Picks the start left out (archived or removed since they were ticked,
      // or rental equipment and kits, which are never counted): said, not
      // silently dropped. Same sentence as the web.
      if (res.skipped > 0) {
        Alert.alert('Count started', cycleCountStartedMessage(res.lineCount, res.skipped));
      }
    } catch (e) {
      setBusy(false);
      Alert.alert('Could not start count', e instanceof Error ? e.message : 'Please try again.');
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/');
            }}
            accessibilityLabel="Back"
            minTap
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`${picks.length} ITEM${picks.length === 1 ? '' : 'S'} SELECTED`}</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            New <Em>count.</Em>
          </Display>
          <Body muted size={13} style={{ marginTop: 8 }}>
            Search and check the items to count — picks made from the Items or Books tabs show up
            here too.
          </Body>
        </View>
      </SafeAreaView>

      {/* The keyboard: the Notes box sits at the foot of the form, and the
          keyboard covered it with no way to scroll it up. The scroll insets
          itself by the keyboard on iOS and brings the focused box into view. */}
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 150, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <ItemPicker selectedCount={picks.length} />

        {products.length > 0 ? (
          <PickGroup title={`PRODUCTS · ${products.length}`} picks={products} />
        ) : null}
        {books.length > 0 ? <PickGroup title={`BOOKS · ${books.length}`} picks={books} /> : null}

        <View style={{ gap: 8 }}>
          <Mono size={11} tracking={0.14} upper color={c.ink3}>
            Notes (optional)
          </Mono>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Spot count · Rack 3"
            placeholderTextColor={c.ink3}
            accessibilityLabel="Notes (optional)"
            multiline
            maxLength={2000}
            style={[
              styles.notes,
              {
                backgroundColor: c.card,
                borderColor: c.hair2,
                color: c.ink,
                fontFamily: FONT.displayRegular,
              },
            ]}
          />
        </View>
      </ScrollView>

      {/* Start count commits the count: the ink button (it was a pressable
          drawn on the ink colour with no button role). Its words stay beside
          the spinner while the count starts. */}
      <SafeAreaView
        edges={['bottom']}
        style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}
      >
        <Button
          block
          onPress={start}
          disabled={busy || picks.length === 0}
          leading={busy ? <ActivityIndicator color={c.paper} /> : undefined}
        >
          Start count
        </Button>
      </SafeAreaView>
    </View>
  );
}

/**
 * Embedded item picker — the mobile twin of web's CountItemPicker
 * (commit 7b738cdc). Replaces the old dead-end empty state that ejected
 * users to the Items/Books tabs' select-mode: Inventory | Books tabs, a
 * debounced name/SKU/barcode search, and a 50-per-page load-more list of
 * checkable rows, all without leaving this screen.
 *
 * Checked state IS the shared count-selection store — the same one the
 * Items/Books tabs' select-mode writes — so both entry paths converge:
 * rows ticked over there arrive pre-checked here, and checking here
 * updates the review list below. The query plan (lib/count-picker.ts,
 * pure + tested) mirrors the tabs' default visibility exactly: active,
 * not deleted, not awaiting first receipt.
 */
function ItemPicker({ selectedCount }: { selectedCount: number }) {
  const { c } = useTheme();
  const { activeOrgId, activeWarehouseId } = useWorkspace();
  const [tab, setTab] = React.useState<CountPickerTab>('product');
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<CountPickerRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [loadingMore, setLoadingMore] = React.useState(false);
  // Bumped by Try again after a failed read: the page-1 fetch below runs
  // again for the same tab, search and workspace.
  const [attempt, setAttempt] = React.useState(0);
  // Monotonic fetch id — a slow page-1 response for a STALE tab/query must
  // not overwrite the list after a newer fetch already landed.
  const seqRef = React.useRef(0);

  const fetchPage = React.useCallback(
    async (offset: number): Promise<{ rows: CountPickerRow[]; count: number } | null> => {
      if (!activeOrgId) return null;
      const plan = countPickerPlan(tab, q, offset);
      let req = supabase
        .from('inventory_items')
        .select('id, name, sku, item_type, quantity_on_hand', { count: 'exact' })
        .eq('organization_id', activeOrgId)
        // Default visibility, verbatim from the Items/Books tabs (via
        // listStatusPredicate): phantoms awaiting their first receipt and
        // soft-deleted rows are never countable.
        .eq('awaiting_first_receipt', plan.awaitingFirstReceipt)
        .is('deleted_at', null)
        // Countable only (server 0369, D8): rental equipment and kit
        // phantoms are never counted, so they are never offered.
        .eq('is_rental', plan.isRental)
        .eq('is_bundle', plan.isBundle)
        .order('name', { ascending: true })
        .range(plan.range.from, plan.range.to);
      if (plan.lifecycle) req = req.eq('status', plan.lifecycle);
      req =
        plan.itemType.op === 'eq'
          ? req.eq('item_type', plan.itemType.value)
          : req.neq('item_type', plan.itemType.value);
      // Honor the drawer workspace's active warehouse — the select-mode
      // path on the tabs is scoped to it, so the inline picker must be too.
      if (activeWarehouseId) req = req.eq('warehouse_id', activeWarehouseId);
      // Word-AND search groups (each .or() is AND-ed by PostgREST).
      for (const group of plan.orGroups) req = req.or(group);
      const { data, count, error } = await req;
      if (error) {
        // The message only, never the whole PostgREST error (its details and
        // hint can quote row values).
        console.warn('count picker', error.message);
        return null;
      }
      const mapped: CountPickerRow[] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          name: r.name as string,
          sku: (r.sku as string | null) ?? '',
          item_type: (r.item_type as string | null) ?? 'product',
          quantity_on_hand: Number(r.quantity_on_hand) || 0,
        };
      });
      return { rows: mapped, count: count ?? 0 };
    },
    [activeOrgId, activeWarehouseId, tab, q],
  );

  // Debounced page-1 fetch on tab / query / workspace change, and on Try
  // again: the trailing 250ms collapses a burst of keystrokes into one
  // request (same debounce the Items tab uses).
  React.useEffect(() => {
    const seq = ++seqRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced search: the sync set is the loading flag for a tab/query/workspace change; every data set is post-await
    setStatus('loading');
    const t = setTimeout(() => {
      void (async () => {
        const res = await fetchPage(0);
        if (seq !== seqRef.current) return; // stale — a newer fetch owns the list
        if (!res) {
          setRows([]);
          setTotal(0);
          setStatus(activeOrgId ? 'failed' : 'loading');
          return;
        }
        setRows(res.rows);
        setTotal(res.count);
        setStatus('ready');
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [fetchPage, activeOrgId, attempt]);

  async function loadMore() {
    if (loadingMore || status !== 'ready') return;
    // Same staleness rule page 1 uses: capture the fetch id BEFORE the
    // await — a tab/query change while page n+1 is in flight bumps seqRef,
    // and appending that late response would mix stale rows into the
    // fresh list.
    const seq = seqRef.current;
    setLoadingMore(true);
    const res = await fetchPage(rows.length);
    if (seq === seqRef.current && res) {
      setRows((prev) => mergeRows(prev, res.rows));
      setTotal(res.count);
    }
    setLoadingMore(false);
  }

  const remaining = Math.max(0, total - rows.length);
  const noun = tab === 'book' ? 'books' : 'items';

  return (
    <View style={{ gap: 10 }}>
      {/* The reference's segmented switch: a recessed track with the chosen
          tab on the card colour, ringed in muted ink (3:1 or more on the
          track in both modes), its words in ink. Each tab is a 44pt target;
          the same tab role, words and selected state. */}
      <View style={[styles.tabs, { backgroundColor: c.sunk }]}>
        <PickerTab label="Inventory" active={tab === 'product'} onPress={() => setTab('product')} />
        <PickerTab label="Books" active={tab === 'book'} onPress={() => setTab('book')} />
      </View>

      {/* The shared input look: the card fill and the stronger border, the
          muted-ink icon and placeholder (ink4 held the placeholder under AA). */}
      <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair2 }]}>
        <Search size={16} color={c.ink3} strokeWidth={1.8} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={
            tab === 'book'
              ? 'Search books by title, SKU, barcode'
              : 'Search items by name, SKU, barcode'
          }
          placeholderTextColor={c.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search items to count"
          style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
        />
        {q.length > 0 ? (
          // A button named for what it does, in a real 44pt frame (it was an
          // unnamed X with hitSlop).
          <Pressable
            onPress={() => setQ('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={({ pressed }) => [styles.clearFrame, { opacity: pressed ? 0.5 : 1 }]}
          >
            <X size={16} color={c.ink3} />
          </Pressable>
        ) : null}
      </View>

      {/* Clipped to its corners: a picked first or last row's wash otherwise
          paints square corners over the card's rounded edge. */}
      <Card padding={0} style={styles.pickerCard}>
        {status === 'loading' ? (
          <ActivityIndicator color={c.ink} style={{ paddingVertical: 28 }} />
        ) : status === 'failed' ? (
          // A failed read says so with a way to read again: it told the
          // person to "pull back in", and nothing on this screen pulled.
          <View style={styles.failed}>
            <Body muted size={13} style={styles.failedText}>
              Couldn&rsquo;t load {noun}. Check your connection and try again.
            </Body>
            <Button variant="outline" size="sm" onPress={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </View>
        ) : rows.length === 0 ? (
          <Body muted size={13} style={styles.listNotice}>
            {q.trim()
              ? `No ${noun} match “${q.trim()}”.`
              : `No countable ${noun} here yet — active ${noun} appear here automatically.`}
          </Body>
        ) : (
          <>
            {rows.map((row, i) => (
              <PickerRow key={row.id} row={row} isFirst={i === 0} />
            ))}
            {remaining > 0 ? (
              <>
                <Hair inset={16} />
                <Pressable
                  onPress={() => void loadMore()}
                  disabled={loadingMore}
                  accessibilityRole="button"
                  // Its words, also while the spinner stands in for them.
                  accessibilityLabel={`Load more (${remaining} remaining)`}
                  accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
                  style={({ pressed }) => [
                    styles.loadMore,
                    { opacity: loadingMore ? 0.5 : pressed ? 0.7 : 1 },
                  ]}
                >
                  {loadingMore ? (
                    <ActivityIndicator color={c.ink} size="small" />
                  ) : (
                    <Mono size={11} tracking={0.12} upper color={c.ink}>
                      Load more ({remaining} remaining)
                    </Mono>
                  )}
                </Pressable>
              </>
            ) : null}
          </>
        )}
      </Card>

      <View style={styles.selectedBar}>
        <Mono size={12.5} color={c.ink3} style={{ fontVariant: ['tabular-nums'] }}>
          {selectedCount} selected
        </Mono>
        {selectedCount > 0 ? (
          <>
            <Mono size={12.5} color={c.ink4}>
              {' · '}
            </Mono>
            <Pressable
              onPress={() => countSelection.clear()}
              accessibilityRole="button"
              style={({ pressed }) => [styles.clearPicks, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Mono size={12.5} color={c.ink3} style={{ textDecorationLine: 'underline' }}>
                Clear
              </Mono>
            </Pressable>
          </>
        ) : (
          <Mono size={12.5} color={c.ink3} style={{ flexShrink: 1 }}>
            {' — check at least one item to start a count'}
          </Mono>
        )}
      </View>
    </View>
  );
}

function PickerTab({
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
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.tabBtn,
        {
          backgroundColor: active ? c.card : 'transparent',
          borderColor: active ? c.ink3 : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Body
        size={13}
        color={active ? c.ink : c.ink3}
        style={{ fontFamily: active ? FONT.displaySemi : FONT.display, textAlign: 'center' }}
      >
        {label}
      </Body>
    </Pressable>
  );
}

/** One checkable row. Checked state subscribes per-id to the shared
 *  count-selection store (useIsPicked), so an Items-tab pick arrives
 *  pre-checked and only the toggled row re-renders. The row is the press
 *  target and VoiceOver's checkbox (role and checked state); it draws the
 *  shared CheckboxMark, and the accent wash while picked (DESIGN-SPEC 6.21,
 *  as the Items and Books rows: paper2 is the card colour in dark mode, so
 *  the old tint showed nothing there). */
const PickerRow = React.memo(function PickerRow({
  row,
  isFirst,
}: {
  row: CountPickerRow;
  isFirst: boolean;
}) {
  const { c } = useTheme();
  const picked = useIsPicked(row.id);
  return (
    <>
      {!isFirst ? <Hair inset={16} /> : null}
      <Pressable
        onPress={() => countSelection.toggle(pickFromRow(row))}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: picked }}
        accessibilityLabel={`Select ${row.name}`}
        style={({ pressed }) => [
          styles.pickerRow,
          { backgroundColor: picked ? c.accentWash : 'transparent', opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14.5} color={c.ink} numberOfLines={2}>
            {row.name}
          </Body>
          {row.sku ? (
            <Mono
              size={11}
              tracking={0.04}
              color={c.ink3}
              numberOfLines={1}
              style={{ marginTop: 2 }}
            >
              {row.sku}
            </Mono>
          ) : null}
        </View>
        <Mono size={11.5} color={c.ink3} style={{ fontVariant: ['tabular-nums'] }}>
          {row.quantity_on_hand} on hand
        </Mono>
        <CheckboxMark checked={picked} />
      </Pressable>
    </>
  );
});

function PickGroup({ title, picks }: { title: string; picks: CountPick[] }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Mono size={11} tracking={0.14} upper color={c.ink3}>
        {title}
      </Mono>
      <Card padding={0}>
        {picks.map((p, i) => (
          <View
            key={p.id}
            style={[
              styles.pickRow,
              i < picks.length - 1 ? { borderBottomWidth: 1, borderBottomColor: c.hair } : null,
            ]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Body size={14.5} color={c.ink} numberOfLines={2}>
                {p.name}
              </Body>
              {p.sku ? (
                <Mono
                  size={11}
                  tracking={0.04}
                  color={c.ink3}
                  numberOfLines={1}
                  style={{ marginTop: 2 }}
                >
                  {p.sku}
                </Mono>
              ) : null}
            </View>
            {/* Named for the pick it removes (it was an unnamed X with
                hitSlop), in a real 44pt frame. */}
            <Pressable
              onPress={() => countSelection.remove(p.id)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${p.name}`}
              style={({ pressed }) => [styles.removeFrame, { opacity: pressed ? 0.5 : 1 }]}
            >
              <X size={18} color={c.ink3} />
            </Pressable>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding (12, 8) and what
  // sits under it 3pt off its top: the chip and the title sit where they did.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 12 },
  // The segmented track: padding 3, radius 10 (DESIGN-SPEC 6.5, the phone's
  // segments), the tabs sized to their words.
  tabs: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  // flexShrink: at the largest text sizes the two words are wider than the
  // screen, so each tab gives way and its word wraps instead of running off
  // the edge.
  tabBtn: {
    minHeight: MIN_TAP,
    flexShrink: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // minHeight, never height: the typed words grow with the text size, and the
  // box grows with them (the fixed 44pt box clipped them at the larger sizes).
  searchBox: {
    minHeight: MIN_TAP,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: RADIUS.tile,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14.5,
    minHeight: 36,
    letterSpacing: -0.17,
  },
  // The clear X's 44pt frame reaches into the box's 4pt padding, so the box
  // keeps its 44pt height.
  clearFrame: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    marginVertical: -4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCard: { overflow: 'hidden' },
  listNotice: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    textAlign: 'center',
  },
  // The failed read: its sentence over Try again (the shared small Button,
  // a 44pt target), centred like the other notices.
  failed: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: 'center',
    gap: 12,
  },
  failedText: { textAlign: 'center' },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: MIN_TAP,
  },
  loadMore: {
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
  },
  selectedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 2,
  },
  // Clear is a 44pt target around the same underlined word.
  clearPicks: {
    minHeight: MIN_TAP,
    minWidth: MIN_TAP,
    justifyContent: 'center',
  },
  notes: {
    minHeight: 64,
    borderRadius: RADIUS.tile,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14.5,
    textAlignVertical: 'top',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 12,
  },
  // The remove X's 44pt frame reaches into the row's padding.
  removeFrame: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    marginVertical: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A pinned bar on the page colour, clear of the home indicator.
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
