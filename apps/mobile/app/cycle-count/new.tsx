import { useRouter } from 'expo-router';
import { ArrowLeft, CheckCircle2, Circle, Search, X } from 'lucide-react-native';
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

import { Card, Hair } from '@/components/ui/card';
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
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

interface StartResult {
  id: string;
  lineCount: number;
  skipped: number;
}

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
    } catch (e) {
      setBusy(false);
      Alert.alert(
        'Could not start count',
        e instanceof Error ? e.message : 'Please try again.',
      );
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
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`${picks.length} ITEM${picks.length === 1 ? '' : 'S'} SELECTED`}</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            New <Em>count.</Em>
          </Display>
          <Body muted size={13} style={{ marginTop: 8 }}>
            Search and check the items to count — picks made from the Items or
            Books tabs show up here too.
          </Body>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 150, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <ItemPicker selectedCount={picks.length} />

        {products.length > 0 ? (
          <PickGroup title={`PRODUCTS · ${products.length}`} picks={products} />
        ) : null}
        {books.length > 0 ? (
          <PickGroup title={`BOOKS · ${books.length}`} picks={books} />
        ) : null}

        <View style={{ gap: 8 }}>
          <Mono size={11} tracking={0.14} upper color={c.ink4}>
            Notes (optional)
          </Mono>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Spot count · Rack 3"
            placeholderTextColor={c.ink4}
            multiline
            maxLength={2000}
            style={[
              styles.notes,
              { backgroundColor: c.card, borderColor: c.hair, color: c.ink, fontFamily: FONT.displayRegular },
            ]}
          />
        </View>
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={styles.footer}>
        <Pressable
          onPress={start}
          disabled={busy || picks.length === 0}
          style={({ pressed }) => [
            styles.startBtn,
            {
              backgroundColor: c.ink,
              opacity: picks.length === 0 ? 0.4 : busy ? 0.6 : pressed ? 0.85 : 1,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={c.paper} />
          ) : (
            <Mono size={14} color={c.paper} style={{ fontFamily: FONT.display }}>
              Start count
            </Mono>
          )}
        </Pressable>
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
        console.warn('count picker', error);
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

  // Debounced page-1 fetch on tab / query / workspace change: the trailing
  // 250ms collapses a burst of keystrokes into one request (same debounce
  // the Items tab uses).
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
  }, [fetchPage, activeOrgId]);

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
      <View style={[styles.tabs, { backgroundColor: c.paper2 }]}>
        <PickerTab label="Inventory" active={tab === 'product'} onPress={() => setTab('product')} />
        <PickerTab label="Books" active={tab === 'book'} onPress={() => setTab('book')} />
      </View>

      <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair }]}>
        <Search size={16} color={c.ink4} strokeWidth={1.8} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={
            tab === 'book'
              ? 'Search books by title, SKU, barcode'
              : 'Search items by name, SKU, barcode'
          }
          placeholderTextColor={c.ink4}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search items to count"
          style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
        />
        {q.length > 0 ? (
          <Pressable onPress={() => setQ('')} hitSlop={8}>
            <X size={16} color={c.ink4} />
          </Pressable>
        ) : null}
      </View>

      <Card padding={0}>
        {status === 'loading' ? (
          <ActivityIndicator color={c.ink} style={{ paddingVertical: 28 }} />
        ) : status === 'failed' ? (
          <Body muted size={13} style={styles.listNotice}>
            Couldn&rsquo;t load {noun}. Check your connection and pull back in.
          </Body>
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
                  style={({ pressed }) => ({
                    alignItems: 'center',
                    paddingVertical: 13,
                    opacity: loadingMore ? 0.5 : pressed ? 0.7 : 1,
                  })}
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
            <Pressable onPress={() => countSelection.clear()} hitSlop={8}>
              <Mono size={12.5} color={c.ink3} style={{ textDecorationLine: 'underline' }}>
                Clear
              </Mono>
            </Pressable>
          </>
        ) : (
          <Mono size={12.5} color={c.ink4}>
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
      style={[styles.tabBtn, active ? { backgroundColor: c.card, borderColor: c.hair } : null]}
    >
      <Mono
        size={12.5}
        color={active ? c.ink : c.ink4}
        style={active ? { fontFamily: FONT.display } : undefined}
      >
        {label}
      </Mono>
    </Pressable>
  );
}

/** One checkable row. Checked state subscribes per-id to the shared
 *  count-selection store (useIsPicked), so an Items-tab pick arrives
 *  pre-checked and only the toggled row re-renders. */
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
          { backgroundColor: picked ? c.paper2 : 'transparent', opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14.5} color={c.ink} numberOfLines={2}>
            {row.name}
          </Body>
          {row.sku ? (
            <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 2 }}>
              {row.sku}
            </Mono>
          ) : null}
        </View>
        <Mono size={11.5} color={c.ink4} style={{ fontVariant: ['tabular-nums'] }}>
          {row.quantity_on_hand} on hand
        </Mono>
        {picked ? (
          <CheckCircle2 size={22} color={c.ink} strokeWidth={2} />
        ) : (
          <Circle size={22} color={c.ink4} strokeWidth={1.6} />
        )}
      </Pressable>
    </>
  );
});

function PickGroup({ title, picks }: { title: string; picks: CountPick[] }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Mono size={11} tracking={0.14} upper color={c.ink4}>
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
                <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 2 }}>
                  {p.sku}
                </Mono>
              ) : null}
            </View>
            <Pressable onPress={() => countSelection.remove(p.id)} hitSlop={10}>
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  tabs: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  tabBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  searchBox: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    height: '100%',
    letterSpacing: -0.17,
  },
  listNotice: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    textAlign: 'center',
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  selectedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  notes: {
    minHeight: 64,
    borderRadius: 10,
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
  },
  startBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
