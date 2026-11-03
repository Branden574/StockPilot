import { History, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { formatHistoryMovement, type ItemHistoryMovement } from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Body, Display, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import {
  appendHistoryMovements,
  formatHistoryWhen,
  historyAmountLines,
  historyProgressLabel,
  ITEM_HISTORY_PAGE_SIZE,
  itemHistoryPath,
  nextHistoryOffset,
  parseItemHistoryPage,
} from '@/lib/item-history';
import { FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Item movement history — the native twin of the web staging table's history
 * dialog.
 *
 * A colleague added 10 units to one book and 10 to another three minutes apart;
 * a manager reversed one of them 26 minutes later noting "incorrectly moved
 * inventory". Nobody could tell from any screen where any of it came from, so
 * the controller reconstructed the story in SQL. This sheet is that story, told
 * from the ledger itself.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *  • it does not pick a "source" for the holding. Two earlier attempts inferred
 *    one winning movement per row and each invented a new way to be confidently
 *    wrong (one widened a query into the PostgREST 1000-row cap; the other
 *    called an internally-cancelled order pick a customer return and reset a
 *    month-old staging row's date to today, deleting its Stale badge). A
 *    history has no winner to choose, so there is no rule to get wrong — and it
 *    touches neither the staging row's source attribution nor its ageDays;
 *  • it does not query Supabase. Rows come from GET /api/v1/items/[id]/history,
 *    which calls the very same InventoryService.itemMovementHistory() the web
 *    dialog renders. A second query here would rebuild the web/mobile
 *    disagreement this feature exists to end;
 *  • it does not word a single row for itself. Every string on a movement comes
 *    out of @stockpilot/core's formatHistoryMovement — the ONE formatter both
 *    surfaces call — so the phone and the browser read identically.
 *
 * The one thing this file formats is the timestamp, in the VIEWER's timezone
 * (formatHistoryWhen, matching web's <LocalDateTime> option-for-option).
 *
 * Everything testable lives in src/lib/item-history.ts; this file is fetch +
 * paint, pinned by item-history-wiring.test.ts.
 */
export function ItemHistorySheet({
  visible,
  itemId,
  itemName,
  itemSku,
  onClose,
}: {
  visible: boolean;
  itemId: string;
  /** Shown in the header until the payload's own name arrives, so the sheet
   *  never opens on a blank title. */
  itemName: string;
  itemSku: string;
  onClose: () => void;
}) {
  const { mode } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/*
       * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
       * ancestor claims the touch on press-down and beats the scrollable's pan
       * recogniser, so the movement list would not scroll until something else
       * took the responder first. Note this sandwich spanned a COMPONENT
       * BOUNDARY — the scrim lived here and the inner swallow-the-tap wrapper
       * lived in ItemHistorySheetContent — so neither file looked wrong on its
       * own. Do not re-nest the content inside the scrim. See
       * add-order-items-sheet.tsx for the measured detail.
       *
       * The scrim is a "Close" button to VoiceOver, which a double tap or the
       * escape scrub closes (onAccessibilityTap / onAccessibilityEscape, the
       * app's sheet rule: sheet-a11y-structure.test.ts has the why), and
       * accessibilityViewIsModal keeps VoiceOver inside the open sheet. Before,
       * the scrim was an unnamed element VoiceOver could land on.
       */}
      <View style={styles.scrim} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Pressable
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        {/* key: remount the content per open/close transition AND per item, so
            every session starts from the empty `loading: true` initial state —
            reset-by-remount instead of a reset-on-open effect. */}
        <ItemHistorySheetContent
          key={`${String(visible)}:${itemId}`}
          visible={visible}
          itemId={itemId}
          itemName={itemName}
          itemSku={itemSku}
          onClose={onClose}
        />
      </View>
    </Modal>
  );
}

function ItemHistorySheetContent({
  visible,
  itemId,
  itemName,
  itemSku,
  onClose,
}: {
  visible: boolean;
  itemId: string;
  itemName: string;
  itemSku: string;
  onClose: () => void;
}) {
  const { c } = useTheme();
  // The list is capped as a FRACTION of the screen, not at a fixed 460pt: on a
  // 4.7" phone a fixed cap pushes the "Load older movements" footer and the
  // error line off the bottom of the sheet, where neither can be reached.
  const { height: windowHeight } = useWindowDimensions();
  const listMaxHeight = Math.max(220, Math.round(windowHeight * 0.52));

  const [rows, setRows] = React.useState<ItemHistoryMovement[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Monotonic sequence guard, same pattern as the staging list: reopening the
  // sheet on a different row fires a new request while the previous one is
  // still in flight, and the slower response must never paint one item's
  // history under another item's name.
  const seqRef = React.useRef(0);

  const load = React.useCallback(
    async (from: number) => {
      const seq = ++seqRef.current;
      try {
        const res = await api<unknown>(
          itemHistoryPath(itemId, { limit: ITEM_HISTORY_PAGE_SIZE, offset: from }),
        );
        if (seq !== seqRef.current) return;
        const page = parseItemHistoryPage(res);
        setRows((prev) => (from === 0 ? page.rows : appendHistoryMovements(prev, page.rows)));
        setTotal(page.total);
        // hasMore is the SERVER's statement, never inferred from a page looking
        // full — that inference is how a paging loop asks forever.
        setHasMore(page.hasMore);
        setOffset(nextHistoryOffset(page));
        setError(null);
      } catch (e) {
        if (seq !== seqRef.current) return;
        // A failed page must not silently truncate the story: keep whatever is
        // already on screen and say the request failed.
        if (from === 0) setRows([]);
        setError(e instanceof Error ? e.message : 'Could not load this item’s history.');
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [itemId],
  );

  // The empty/loading reset the old version wrote here is now the component's
  // initial state, restored by the remount key above on every open and item
  // change; the effect only starts the fetch (every set inside load() is
  // post-await, behind the seq guard).
  React.useEffect(() => {
    if (!visible || !itemId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load(0);
  }, [visible, itemId, load]);

  function loadMore() {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    void load(offset);
  }

  return (
    // Plain View on purpose: this was a Pressable whose only job was to swallow
    // backdrop taps, and being a touch responder it beat the FlatList's pan
    // recogniser. The scrim now sits behind as a sibling, so taps outside still
    // close and this claims no responder. See add-order-items-sheet.tsx.
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
          {/* The grabber is a decorative mark in the faint ink. */}
          <View style={[styles.grabber, { backgroundColor: c.ink5 }]} />
        </View>
      ) : null}

      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          <History size={16} color={c.ink} strokeWidth={1.6} />
          <Mono size={13} tracking={0.08} style={{ fontFamily: FONT.display, color: c.ink }}>
            HISTORY
          </Mono>
        </View>
        {/* Close: a named button (VoiceOver found an icon with no words and
            no role) in a 44pt frame around the same 18pt X, its margins giving
            the space back (it was the X with hitSlop), in the muted ink. */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}
        >
          <X size={18} color={c.ink3} strokeWidth={1.6} />
        </Pressable>
      </View>

      <View style={styles.title}>
        <Display size={19} style={{ marginBottom: 4 }}>
          {itemName}
        </Display>
        {/* The SKU and the count of movements: information, in the muted ink
            (the faint ink held them under AA). */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Mono size={10.5} color={c.ink3}>
            {itemSku}
          </Mono>
          {/* The counter must never assert an empty ledger for a request
              that never came back — see historyProgressLabel's `failed`
              argument, and the ListEmptyComponent comment below. */}
          {loading ? null : (
            <Mono size={10.5} color={c.ink3}>
              {historyProgressLabel(rows.length, total, error !== null)}
            </Mono>
          )}
        </View>
      </View>

      <FlatList
        data={loading ? [] : rows}
        keyExtractor={(m) => m.id}
        style={{ maxHeight: listMaxHeight }}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={c.ink} style={{ marginTop: 28, marginBottom: 28 }} />
          ) : error ? (
            // The failure is already spelled out below the list. Do NOT also
            // claim "no movements" — an unread request is not an empty
            // ledger, and conflating the two is the same category of lie as
            // the em dash this feature exists to remove.
            <View style={styles.empty}>
              <Body muted style={{ textAlign: 'center' }}>
                Try again.
              </Body>
            </View>
          ) : (
            <View style={styles.empty}>
              <Body muted style={{ textAlign: 'center' }}>
                No stock movements recorded for this item.
              </Body>
            </View>
          )
        }
        renderItem={({ item }) => <MovementRow row={item} />}
        ListFooterComponent={
          !loading && hasMore ? (
            <View style={{ paddingTop: 12 }}>
              <Button
                size="sm"
                variant="outline"
                block
                disabled={loadingMore}
                onPress={loadMore}
                // 44pt, not the small Button's 36.
                style={{ minHeight: MIN_TAP }}
              >
                {loadingMore ? 'Loading…' : 'Load older movements'}
              </Button>
            </View>
          ) : null
        }
      />

      {error ? (
        <View style={{ paddingHorizontal: 22, paddingTop: 10, gap: 10 }}>
          {/* The failure, in the mode's refusal red (the single-mode red was
              3.1-3.3:1 on the dark card). */}
          <Mono size={11.5} color={c.critText} accessibilityRole="alert">
            {error}
          </Mono>
          <Button
            size="sm"
            variant="outline"
            block
            onPress={() => {
              setLoading(true);
              void load(0);
            }}
            // 44pt, not the small Button's 36.
            style={{ minHeight: MIN_TAP }}
          >
            Try again
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/**
 * One movement, told in the shared formatter's words.
 *
 * Every field below is rendered ONLY when the formatter returned something for
 * it. A null means "we have nothing to say here" and the line is omitted — no
 * placeholder, no em dash, no "System" standing in for an absent actor. That is
 * the whole truthfulness contract: say nothing you cannot support.
 */
function MovementRow({ row }: { row: ItemHistoryMovement }) {
  const { c } = useTheme();
  const f = formatHistoryMovement(row);
  const when = formatHistoryWhen(f.whenIso);
  const amount = historyAmountLines(f);

  // The amount in the mode's tones (accent for stock in, refusal red for
  // stock out, warning amber for the rest), each 4.5:1 or more on the row's
  // recessed fill in both modes; the single-mode red and amber were not.
  const toneColor =
    f.tone === 'pos'
      ? c.accent
      : f.tone === 'neg'
        ? c.critText
        : f.tone === 'warn'
          ? c.warnText
          : c.ink3;

  return (
    // A movement on the recessed fill, inside the sheet's card.
    <View style={[styles.row, { borderColor: c.hair, backgroundColor: c.sunk }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {f.title}
          </Body>
          {/* WHEN. Absolute local date + time — the owner asked "on what date
              and time", and a relative "2 days ago" cannot answer that. Omitted
              entirely if the timestamp does not parse. */}
          {when ? (
            <Mono size={10.5} color={c.ink3} style={{ marginTop: 3 }}>
              {when}
            </Mono>
          ) : null}
        </View>
        {amount.primary ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Display size={19} color={toneColor}>
              {amount.primary}
            </Display>
            {/* A row carrying BOTH an on-hand delta and a moved quantity shows
                both — dropping one is how a number goes missing. */}
            {amount.secondary ? (
              <Mono size={10.5} color={c.ink3} style={{ marginTop: 2 }}>
                {amount.secondary}
              </Mono>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={{ marginTop: 10, gap: 6 }}>
        {/* WHO. Rendered only when the ledger names someone. A trigger/system
            write has no actor and gets no actor line. */}
        <Field label="WHO" value={f.actorLabel} />
        <Field label="EMAIL" value={f.actorEmailLabel} />
        <Field label="WHERE" value={f.routeLabel} />
        <Field label="ON HAND" value={f.onHandLabel} />
        {/* WHY. The operator's typed words only — never `receipt_line`,
            `duplicate_initial_count`, a bare "PO {number}" or a raw uuid. */}
        <Field label="WHY" value={f.noteLabel} />
        <Field label="SOURCE" value={f.sourceLabel} />
      </View>

      {/* A received-then-reversed pair nets to zero. A reader who cannot see
          the pairing misreads the whole history as stock that arrived and
          stayed, so the link is called out rather than left to be inferred from
          two rows that happen to be equal and opposite. */}
      {f.reversalLabel ? (
        // On the warning wash with the warning ink (4.70:1 light, 8.01:1
        // dark); the fixed amber tints read 3.0:1 or less in light.
        <View style={[styles.reversal, { borderColor: c.warnWash, backgroundColor: c.warnWash }]}>
          <Mono size={10.5} color={c.warnText}>
            {f.reversalLabel}
          </Mono>
        </View>
      ) : null}
    </View>
  );
}

/** One label/value line. Renders nothing at all for a null value. */
function Field({ label, value }: { label: string; value: string | null }) {
  const { c } = useTheme();
  if (!value) return null;
  return (
    <View style={styles.fieldRow}>
      {/* The label names the value beside it: the muted ink. */}
      <Mono size={10} tracking={0.12} upper color={c.ink3}>
        {label}
      </Mono>
      <Mono size={11.5} color={c.ink2} style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Mono>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
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
  header: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  // The frame keeps the X's 18pt in the layout, so the header and the X stay
  // where they were. Below, it reaches only the header's 8pt bottom padding,
  // ending where the item name (a later sibling, which would win the tap)
  // starts; the other 18pt go above, into the header's top padding and the
  // grabber row's empty right side, where nothing is tappable. The equal
  // padding keeps the X centred where it was; to the right, (44 - 18) / 2.
  close: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    marginTop: -18,
    marginBottom: -8,
    paddingTop: 18,
    paddingBottom: 8,
    marginRight: -13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    paddingHorizontal: 22,
    paddingBottom: 12,
  },
  list: {
    paddingHorizontal: 22,
    paddingBottom: 6,
    gap: 10,
  },
  row: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  reversal: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  empty: {
    paddingVertical: 28,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
});
