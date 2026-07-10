import { Landmark } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, Pressable, TextInput, View } from 'react-native';

import { Body, Eyebrow, Mono } from '@/components/ui/text';
import {
  getOrderDetail,
  recordPickedLine,
  transitionOrder,
  type OrderDetailLine,
} from '@/lib/orders-api';
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
 */
export function DigitalPick({
  orderId,
  onCompleted,
  canPick = true,
}: {
  orderId: string;
  /** Called after a successful complete so the parent screen can reload. */
  onCompleted: () => void;
  /**
   * Whether the viewer may actually pick this order. The parent screen decides
   * this from the picking claim/lock rules (assigned picker or a manager). When
   * false we render a muted notice instead of the pick inputs — defense-in-depth
   * so the workspace can never be shown to a non-claimant even if mis-rendered
   * (the server also rejects the write).
   */
  canPick?: boolean;
}) {
  const { c, mode } = useTheme();
  const [lines, setLines] = React.useState<OrderDetailLine[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Current text in each line's input, and the last-persisted qty per line.
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [saved, setSaved] = React.useState<Record<string, number>>({});
  const [savingLine, setSavingLine] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const detail = await getOrderDetail(orderId);
      setLines(detail.lines);
      const seededQty: Record<string, string> = {};
      const seededSaved: Record<string, number> = {};
      for (const l of detail.lines) {
        const picked = l.quantity_picked != null ? Number(l.quantity_picked) : 0;
        seededQty[l.id] = String(picked);
        seededSaved[l.id] = picked;
      }
      setQty(seededQty);
      setSaved(seededSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load order lines.');
    }
  }, [orderId]);

  React.useEffect(() => {
    void load();
  }, [load]);

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

  // Short-completion guard: if completing now leaves units owed, the order
  // forks to backordered — confirm before that happens silently.
  function onCompleteClick() {
    if (!lines) return;
    const shipsNow = lines.reduce((s, l) => s + clampFor(l, qty[l.id] ?? '0'), 0);
    const backorderQty = lines.reduce((s, l) => {
      const owedBefore = Math.max(
        0,
        (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
      );
      return s + Math.max(0, owedBefore - clampFor(l, qty[l.id] ?? '0'));
    }, 0);
    if (backorderQty > 0) {
      Alert.alert(
        'Ship short and backorder the rest?',
        `This ships ${shipsNow} now and backorders ${backorderQty}. The order stays open as "Backordered" so you can fulfill the remainder once stock is available.`,
        [
          { text: 'Keep picking', style: 'cancel' },
          {
            text: `Ship ${shipsNow} & backorder ${backorderQty}`,
            onPress: () => void complete(),
          },
        ],
      );
      return;
    }
    void complete();
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
        <Pressable onPress={() => void load()}>
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
        <Pressable onPress={fillAll} hitSlop={8}>
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TextInput
                value={qty[line.id] ?? '0'}
                onChangeText={(t) => setQty((q) => ({ ...q, [line.id]: t }))}
                onBlur={() =>
                  setQty((q) => ({ ...q, [line.id]: String(clampFor(line, q[line.id] ?? '0')) }))
                }
                keyboardType="number-pad"
                selectTextOnFocus
                style={{
                  width: 84,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 10,
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  color: c.ink,
                  fontFamily: FONT.mono,
                  fontSize: 16,
                  textAlign: 'center',
                }}
              />
              <Mono size={11} color={c.ink4}>of {requested}</Mono>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => void saveLine(line)}
                disabled={!dirty || savingLine === line.id}
                style={{
                  borderWidth: 1,
                  borderColor: c.ink,
                  borderRadius: 10,
                  paddingVertical: 8,
                  paddingHorizontal: 16,
                  opacity: !dirty || savingLine === line.id ? 0.4 : 1,
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
        disabled={!anyPicked || completing}
        style={{
          borderRadius: 12,
          paddingVertical: 14,
          alignItems: 'center',
          backgroundColor: c.ink,
          opacity: !anyPicked || completing ? 0.4 : 1,
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
    </View>
  );
}
