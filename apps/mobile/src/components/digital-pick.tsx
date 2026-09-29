import { Landmark } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, Pressable, TextInput, View } from 'react-native';

import {
  digitalPickCompletionConfirm,
  lineOwedUnits,
  READINESS_NEEDS_CONNECTION_COPY,
  type OrderReadinessResult,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import {
  getOrderDetail,
  recordPickedLine,
  transitionOrder,
  type OrderDetailLine,
} from '@/lib/orders-api';
import { completionConfirmButtons, completionConfirmMessage } from '@/lib/pick-completion';
import { mergePickQuantities, seedSavedQuantities } from '@/lib/pick-quantities';
import {
  PICK_QTY_FIELD_MIN_WIDTH,
  PICK_QTY_FONT_SIZE,
  PICK_QTY_MAX_FONT_SIZE_MULTIPLIER,
  PICK_QTY_PADDING_X,
} from '@/lib/pick-qty-field';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Native line-by-line digital picking — the mobile parity for the web
 * DigitalPick workspace. Previously the app could only "mark all complete"
 * (every line at its full requested qty). Here a picker enters the ACTUAL
 * quantity picked per line (supporting partial picks), saves each, then
 * completes — which decrements stock by the picked amounts.
 *
 * Invariant carried over from web: before completing we FLUSH any typed-but-
 * unsaved line quantities, because complete_picking only decrements stock for
 * lines whose quantity_picked was persisted (a NULL line falls back to its
 * requested qty only when EVERY line is NULL — the old bulk path).
 *
 * F2-2 (SO-000100): Complete asks first, in core's words, whenever a line
 * will come up short, the pick would fail (units in Staging are never
 * picked), or stock could not be checked: core digitalPickCompletionConfirm
 * decides (the web digital pick's own), lib/pick-completion.ts makes it an
 * Alert.
 * "Review short lines" puts the cursor in the first short line's quantity
 * here, as the web digital pick does: the confirm's line comes from what the
 * picker typed, so the count is what to check first. The line's own fixes
 * (lower, remove) stay on the order screen, where a line short by readiness
 * offers them.
 */
export function DigitalPick({
  orderId,
  onCompleted,
  canPick = true,
  reloadToken = 0,
  offline = false,
  readiness = null,
}: {
  orderId: string;
  /** Called after a successful complete so the parent screen can reload. */
  onCompleted: () => void;
  /**
   * Bump to pull fresh lines in WITHOUT discarding work in progress — the
   * parent uses it after items are added mid-pick.
   *
   * This exists because the parent used to remount the workspace with a
   * changing `key`. That threw away every typed-but-unsaved quantity: they live
   * in local `qty` state and only reach the server on Save or Complete, so a
   * picker who had entered 3 and 5 lost both, and a following "Complete
   * picking" saw no dirty lines and shipped those lines at zero. A merging
   * reload keeps the typed values and seeds only the lines that are new.
   */
  reloadToken?: number;
  /**
   * Whether the viewer may actually pick this order. The parent screen decides
   * this from the picking claim/lock rules (assigned picker or a manager). When
   * false we render a muted notice instead of the pick inputs — defense-in-depth
   * so the workspace can never be shown to a non-claimant even if mis-rendered
   * (the server also rejects the write).
   */
  canPick?: boolean;
  /**
   * No connection: Save and Complete are disabled with the reason ("Needs a
   * connection."). The inputs stay, and so does everything typed in them:
   * the workspace is never unmounted for a dropped connection, because the
   * typed quantities live only here until Save or Complete.
   */
  offline?: boolean;
  /**
   * F2-2: the order screen's readiness (core's assessment), which the
   * completion confirm projects what the picker entered against. Null when
   * it was not read or failed: the confirm then says stock couldn't be
   * checked, and is never skipped.
   */
  readiness?: OrderReadinessResult | null;
}) {
  const { c, mode } = useTheme();
  const [lines, setLines] = React.useState<OrderDetailLine[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Current text in each line's input, and the last-persisted qty per line.
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [saved, setSaved] = React.useState<Record<string, number>>({});
  const [savingLine, setSavingLine] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);
  // Each line's quantity field, so "Review short lines" can take the picker
  // straight to it.
  const inputs = React.useRef<Record<string, TextInput | null>>({});

  const load = React.useCallback(
    async (preserveTyped = false) => {
      setError(null);
      try {
        const detail = await getOrderDetail(orderId);
        setLines(detail.lines);
        // `saved` is always re-seeded from the server: it is the persisted
        // truth and what isDirty() compares against. `qty` is the picker's
        // in-progress input, so on a merging reload it is kept for every line
        // already on screen and seeded only for lines that are new. Both rules
        // live in lib/pick-quantities.ts so they are testable on their own.
        setQty((prev) => mergePickQuantities(prev, detail.lines, preserveTyped));
        setSaved(seedSavedQuantities(detail.lines));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load order lines.');
      }
    },
    [orderId],
  );

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: load()'s only pre-await set clears a stale error (a no-op on mount, load-bearing for the reloadToken path); every result set is post-await
    void load();
  }, [load]);

  // Refresh on demand (a line was added while the workspace was open). The ref
  // makes the first render a no-op, so this never double-fetches on mount.
  const seenToken = React.useRef(reloadToken);
  React.useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    void load(true);
  }, [reloadToken, load]);

  function clampFor(line: OrderDetailLine, raw: string): number {
    const n = Math.floor(Number(raw.replace(/[^0-9]/g, '')) || 0);
    return Math.max(0, Math.min(n, Number(line.quantity_requested) || 0));
  }

  function isDirty(line: OrderDetailLine): boolean {
    return clampFor(line, qty[line.id] ?? '0') !== (saved[line.id] ?? 0);
  }

  async function saveLine(line: OrderDetailLine) {
    const n = clampFor(line, qty[line.id] ?? '0');
    setSavingLine(line.id);
    try {
      await recordPickedLine(orderId, line.id, n);
      setSaved((s) => ({ ...s, [line.id]: n }));
      setQty((q) => ({ ...q, [line.id]: String(n) }));
    } catch (e) {
      Alert.alert('Could not save pick', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSavingLine(null);
    }
  }

  async function complete() {
    if (!lines) return;
    setCompleting(true);
    try {
      // Flush any typed-but-unsaved quantities first so complete_picking sees
      // accurate per-line numbers (see the invariant note above).
      for (const l of lines) {
        if (isDirty(l)) {
          const n = clampFor(l, qty[l.id] ?? '0');
          await recordPickedLine(orderId, l.id, n);
          setSaved((s) => ({ ...s, [l.id]: n }));
        }
      }
      await transitionOrder(orderId, { action: 'complete_picking' });
      onCompleted();
    } catch (e) {
      Alert.alert('Could not complete picking', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setCompleting(false);
    }
  }

  // The completion confirm (F2-2, the SO-000100 fix): core's words, over
  // what the picker entered. Shown whenever a line comes up short, the pick
  // would fail, or stock could not be checked (never skipped then); with
  // nothing to say, picking completes at once.
  function onCompleteClick() {
    if (!lines) return;
    const confirm = digitalPickCompletionConfirm(
      lines.map((l) => {
        // The one definition of owed (core lineOwedUnits, pattern #26).
        const owedBefore = lineOwedUnits({
          quantityRequested: l.quantity_requested,
          quantityFulfilled: l.quantity_fulfilled,
        });
        return {
          id: l.id,
          itemName: l.item?.name ?? null,
          owed: owedBefore,
          picking: clampFor(l, qty[l.id] ?? '0'),
        };
      }),
      readiness,
    );
    if (confirm) {
      Alert.alert(
        confirm.title,
        completionConfirmMessage(confirm),
        completionConfirmButtons(confirm, {
          onReview: reviewLine,
          onComplete: () => void complete(),
        }),
      );
      return;
    }
    void complete();
  }

  // "Review short lines": the first short line's quantity takes the focus so
  // the count can be checked (the web digital pick's behaviour). Never the
  // order-line editor: a mistyped count is fixed here, not by changing the
  // customer's order.
  function reviewLine(lineId: string | null) {
    if (lineId) inputs.current[lineId]?.focus();
  }

  if (!canPick) {
    // Locked to another picker — show a muted notice, never the pick inputs.
    return (
      <View
        style={{
          borderWidth: 1,
          borderColor: c.hair,
          borderRadius: 12,
          padding: 14,
          backgroundColor: c.card,
        }}
      >
        <Mono size={11.5} color={c.ink4}>Being picked by another picker.</Mono>
      </View>
    );
  }
  if (error) {
    return (
      <View style={{ gap: 8 }}>
        <Mono size={11} color="#b42318">{error}</Mono>
        <Pressable
          onPress={() => void load()}
          accessibilityRole="button"
          style={{ minHeight: MIN_TAP, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Mono size={12} color={c.ink}>Tap to retry</Mono>
        </Pressable>
      </View>
    );
  }
  if (!lines) {
    return <ActivityIndicator color={c.ink} />;
  }

  const anyPicked = lines.some((l) => clampFor(l, qty[l.id] ?? '0') > 0);
  const allPicked = lines.every((l) => clampFor(l, qty[l.id] ?? '0') > 0);

  function fillAll() {
    setQty((q) => {
      const next = { ...q };
      for (const l of lines!) next[l.id] = String(Number(l.quantity_requested) || 0);
      return next;
    });
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Eyebrow>DIGITAL PICKING</Eyebrow>
        <View style={{ flex: 1 }} />
        {/* Quick path: set every line to its requested qty (still Save/Complete). */}
        <Pressable
          onPress={fillAll}
          accessibilityRole="button"
          style={{ minHeight: MIN_TAP, justifyContent: 'center' }}
        >
          <Mono size={11} color={c.ink}>Fill all as requested</Mono>
        </Pressable>
      </View>
      {lines.map((line) => {
        const requested = Number(line.quantity_requested) || 0;
        const dirty = isDirty(line);
        return (
          <View
            key={line.id}
            style={{
              borderWidth: 1,
              borderColor: c.hair,
              borderRadius: 12,
              padding: 12,
              gap: 8,
              backgroundColor: c.card,
            }}
          >
            <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
              {line.item?.name ?? 'Item'}
            </Body>
            <Mono size={11} color={c.ink4}>
              {line.item?.sku ?? '—'} · requested {requested}
            </Mono>
            {line.item?.charter_name ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  alignSelf: 'flex-start',
                  // maxWidth + flexShrink are BOTH required for numberOfLines
                  // to ellipsize in RN (default flexShrink is 0; a flex-start
                  // chip is otherwise measured at max-content and overflows).
                  maxWidth: '100%',
                  gap: 3,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 999,
                  backgroundColor: ACCENT.mintSoft,
                }}
              >
                <Landmark size={10} color={mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk} />
                <Mono
                  size={10}
                  color={mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk}
                  numberOfLines={1}
                  style={{ flexShrink: 1 }}
                >
                  {line.item.charter_code
                    ? `${line.item.charter_name} (${line.item.charter_code})`
                    : line.item.charter_name}
                </Mono>
              </View>
            ) : null}
            {/* Wraps at the largest text sizes, where the field, "of 30" and
                Save no longer fit on one line of a phone, instead of pushing
                Save past the card. One line at every other size. */}
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <TextInput
                ref={(el) => {
                  inputs.current[line.id] = el;
                }}
                accessibilityLabel={`Picked, ${line.item?.name ?? 'Item'}, of ${requested}`}
                value={qty[line.id] ?? '0'}
                onChangeText={(t) => setQty((q) => ({ ...q, [line.id]: t }))}
                onBlur={() =>
                  setQty((q) => ({ ...q, [line.id]: String(clampFor(line, q[line.id] ?? '0')) }))
                }
                keyboardType="number-pad"
                selectTextOnFocus
                // The typed quantity stops growing at the input ceiling (24pt)
                // and the box is wide enough for three digits at that size: it
                // was a fixed 84pt box with uncapped text, so at AX5 "30" showed
                // as "3" (lib/pick-qty-field.ts).
                maxFontSizeMultiplier={PICK_QTY_MAX_FONT_SIZE_MULTIPLIER}
                style={{
                  minWidth: PICK_QTY_FIELD_MIN_WIDTH,
                  minHeight: MIN_TAP,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 10,
                  paddingVertical: 8,
                  paddingHorizontal: PICK_QTY_PADDING_X,
                  color: c.ink,
                  fontFamily: FONT.mono,
                  fontSize: PICK_QTY_FONT_SIZE,
                  textAlign: 'center',
                }}
              />
              <Mono size={11} color={c.ink4}>of {requested}</Mono>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => void saveLine(line)}
                disabled={!dirty || savingLine === line.id || offline}
                accessibilityRole="button"
                accessibilityState={{ disabled: !dirty || savingLine === line.id || offline }}
                style={{
                  minHeight: MIN_TAP,
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: c.ink,
                  borderRadius: 10,
                  paddingVertical: 8,
                  paddingHorizontal: 16,
                  opacity: !dirty || savingLine === line.id || offline ? 0.4 : 1,
                  backgroundColor: dirty ? c.ink : 'transparent',
                }}
              >
                <Mono size={12} color={dirty ? c.paper : c.ink}>
                  {savingLine === line.id ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                </Mono>
              </Pressable>
            </View>
          </View>
        );
      })}

      <Pressable
        onPress={onCompleteClick}
        disabled={!anyPicked || completing || offline}
        accessibilityRole="button"
        accessibilityState={{ disabled: !anyPicked || completing || offline }}
        style={{
          minHeight: MIN_TAP,
          justifyContent: 'center',
          borderRadius: 12,
          paddingVertical: 14,
          alignItems: 'center',
          backgroundColor: c.ink,
          opacity: !anyPicked || completing || offline ? 0.4 : 1,
        }}
      >
        <Mono size={13} color={c.paper}>
          {completing
            ? 'Completing…'
            : allPicked
              ? 'Complete picking'
              : 'Complete picking (partial)'}
        </Mono>
      </Pressable>
      {offline ? (
        <Body size={12.5} muted>
          {READINESS_NEEDS_CONNECTION_COPY}
        </Body>
      ) : null}
    </View>
  );
}
