import { Search, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { MIN_TAP } from '@/components/item-verification-card';
import { Card, Hair } from '@/components/ui/card';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import { parseHoldOutcome } from '@/lib/order-hold';
import { supabase } from '@/lib/supabase';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import {
  ADD_LINES_INDETERMINATE_COPY,
  ADD_LINES_INDETERMINATE_TITLE,
  addItemsPickerPlan,
  addItemsStepperLabel,
  addLinesErrorIsIndeterminate,
  addLinesErrorIsTerminal,
  buildAddLinesPayload,
  describeAddLinesError,
  stepAddQuantity,
  type AddLinesResult,
} from './add-order-items';

/**
 * Native "add items to an existing order" sheet — the mobile twin of the web
 * add-items dialog. Both submit to the SAME gated service method
 * (OrderRequestsService.addLines) through POST /api/v1/orders/[id]/lines, so
 * the platforms cannot drift.
 *
 * Two transports on purpose, matching the cycle-count picker's precedent:
 *  • READ — a direct RLS-scoped Supabase query on inventory_items. There is no
 *    /api/v1 item-SEARCH route (only exact-match items/lookup, which is
 *    org-wide and so cannot be warehouse-constrained).
 *  • WRITE — the Bearer route, which re-asserts every gate server-side.
 *
 * The picker's predicates are chosen to pre-empt each addLines rejection: it
 * offers only active, non-deleted, already-received items IN THE ORDER'S OWN
 * warehouse. Anything else is a guaranteed 400.
 *
 * VoiceOver and the redesign look: the sheet is the shared sibling-backdrop
 * shape (a "Close" scrim behind a plain card, VoiceOver kept inside, Escape
 * and a double-tap on the scrim close it), its title a header; Close, Clear
 * search, the steppers and Load more are named 44pt buttons with no hitSlop;
 * the search box and Add to order grow with the text (minHeight, never a
 * fixed height); sentences are muted ink (ink3, AA) in the body face, the
 * refusal the per-mode refusal ink; Add to order is the ink button and keeps
 * its words beside the spinner.
 */

interface PickerRow {
  id: string;
  name: string;
  sku: string;
  quantityOnHand: number;
}

export function AddOrderItemsSheet({
  visible,
  onClose,
  orderId,
  organizationId,
  warehouseId,
  existingItemIds,
  onAdded,
  onRequestReload,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  organizationId: string | null;
  /** The ORDER's warehouse, NOT the workspace's active one — addLines rejects
   *  any item stocked elsewhere. */
  warehouseId: string | null;
  /** Items already on the order, so a row can say it will be topped up. */
  existingItemIds: readonly string[];
  onAdded: (result: AddLinesResult) => void;
  /** Called when the failure means the screen's picture of the order is stale
   *  (shipped, cancelled, permission revoked) so it can reload and re-gate. */
  onRequestReload: () => void;
}) {
  const { c, mode } = useTheme();
  const { height } = useWindowDimensions();
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<PickerRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, number>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Monotonic fetch id — a slow page-1 response for a STALE query must not
  // overwrite the list after a newer fetch already landed (same guard the
  // cycle-count picker uses).
  const seqRef = React.useRef(0);

  const onOrder = React.useMemo(() => new Set(existingItemIds), [existingItemIds]);

  // Fixed pixel height computed from the window. Percentage / aspectRatio
  // sizing is what collapsed the size-count grid under Fabric, so this sheet
  // never uses it — every row is a plain flex row with intrinsic-width controls.
  const listMaxHeight = Math.round(height * 0.42);

  const fetchPage = React.useCallback(
    async (offset: number): Promise<{ rows: PickerRow[]; count: number } | null> => {
      if (!organizationId || !warehouseId) return null;
      const plan = addItemsPickerPlan(q, offset);
      let req = supabase
        .from('inventory_items')
        .select('id, name, sku, quantity_on_hand', { count: 'exact' })
        .eq('organization_id', organizationId)
        // The ORDER's warehouse. addLines rejects any item whose warehouse_id
        // differs from the order header's, so offering one is a certain 400.
        .eq('warehouse_id', warehouseId)
        // mig 0277 phantoms are rejected by addLines ("hasn't been received
        // yet"), so they must never be offerable.
        .eq('awaiting_first_receipt', plan.awaitingFirstReceipt)
        // Rental items go out through Rentals, never on an order, and
        // addLines refuses them, so they must never be offerable either.
        .eq('is_rental', false)
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .range(plan.range.from, plan.range.to);
      if (plan.lifecycle) req = req.eq('status', plan.lifecycle);
      // Word-AND search (PostgREST ANDs successive .or() groups).
      for (const group of plan.orGroups) req = req.or(group);
      const { data, count, error: qErr } = await req;
      if (qErr) return null;
      const mapped: PickerRow[] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          name: (r.name as string | null) ?? 'Unnamed item',
          sku: (r.sku as string | null) ?? '',
          quantityOnHand: Number(r.quantity_on_hand) || 0,
        };
      });
      return { rows: mapped, count: count ?? 0 };
    },
    [organizationId, warehouseId, q],
  );

  // Debounced page-1 fetch. Only runs while the sheet is open so a closed
  // sheet never holds a query open behind the screen.
  React.useEffect(() => {
    if (!visible) return;
    const seq = ++seqRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced search fetch: the sync set marks status pending for the query this run owns (mount AND every q change, so an initial value cannot cover it); every result set is post-await behind the seq guard
    setStatus('loading');
    const t = setTimeout(() => {
      void (async () => {
        const res = await fetchPage(0);
        if (seq !== seqRef.current) return; // stale — a newer fetch owns the list
        if (!res) {
          setRows([]);
          setTotal(0);
          setStatus(organizationId && warehouseId ? 'failed' : 'loading');
          return;
        }
        setRows(res.rows);
        setTotal(res.count);
        setStatus('ready');
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [visible, fetchPage, organizationId, warehouseId]);

  // Reset the draft (and the query) each time the sheet is opened, so a
  // previous session's selection can never be submitted by accident.
  React.useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- modal reset on open; remount-keying unsafe here because the sheet owns its Modal and the query being reset also drives the debounced fetch effect above — keying would mean relocating all sheet state (draft, seq guard, submit pipeline) into a new inner component
    setDraft({});
    setError(null);
    setQ('');
  }, [visible]);

  async function loadMore() {
    if (loadingMore || status !== 'ready') return;
    // Capture the fetch id BEFORE the await — a query change while page n+1 is
    // in flight bumps seqRef, and appending that late response would mix stale
    // rows into the fresh list.
    const seq = seqRef.current;
    setLoadingMore(true);
    const res = await fetchPage(rows.length);
    if (seq === seqRef.current && res) {
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...res.rows.filter((r) => !seen.has(r.id))];
      });
      setTotal(res.count);
    }
    setLoadingMore(false);
  }

  function step(itemId: string, delta: number) {
    setDraft((prev) => ({ ...prev, [itemId]: stepAddQuantity(prev[itemId] ?? 0, delta) }));
    setError(null);
  }

  function requestClose() {
    if (submitting) return;
    onClose();
  }

  async function submit() {
    if (submitting) return;
    const payload = buildAddLinesPayload(draft);
    if (!payload.ok) {
      setError(payload.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ ok: true; hold?: unknown } & Omit<AddLinesResult, 'hold'>>(
        `/api/v1/orders/${orderId}/lines`,
        {
          method: 'POST',
          body: { lines: payload.lines },
        },
      );
      onAdded({
        added: Number(res.added) || 0,
        merged: Number(res.merged) || 0,
        pickSlipStale: res.pickSlipStale === true,
        // F2-2: the automatic hold for what was just added, read defensively
        // (an older server sends none). A failure is said in the
        // confirmation ("Added. Stock was not held for it; use Hold
        // available stock."), never dropped.
        hold: parseHoldOutcome(res.hold),
      });
    } catch (e) {
      const message = describeAddLinesError(e);
      // The order shipped / was cancelled / the viewer's grant changed — the
      // draft cannot fix that, so close and let the screen re-gate instead of
      // leaving a dead sheet over an order that no longer accepts items. The
      // reason goes in an Alert, because an inline message on a sheet that is
      // closing in the same frame would never be read.
      if (addLinesErrorIsTerminal(e)) {
        setError(null);
        onClose();
        Alert.alert('Could not add items', message);
        onRequestReload();
      } else if (addLinesErrorIsIndeterminate(e)) {
        // No HTTP status came back (api() aborts at 20s, or the socket died),
        // so we do not know whether the write landed — and addLines is NOT
        // idempotent: one UPDATE per merged item plus one INSERT, no
        // transaction. Leaving the draft on screen with "try again" invites a
        // second full application of every quantity. Close, reload, and say
        // plainly that the order has to be checked first.
        setError(null);
        onClose();
        Alert.alert(ADD_LINES_INDETERMINATE_TITLE, ADD_LINES_INDETERMINATE_COPY);
        onRequestReload();
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const selectedCount = Object.values(draft).filter((n) => n > 0).length;
  const remaining = Math.max(0, total - rows.length);

  // A 44pt frame around the same 32pt box: a real frame, not hitSlop, so the
  // element VoiceOver outlines is the target a finger can hit. The label names
  // the item ("Increase quantity of Hold Base Item"); every row's steppers
  // used to read the same two words. The glyph is a control label, capped at
  // the control ceiling so it stays inside its 32pt box.
  const stepBtn = (
    label: string,
    itemId: string,
    name: string,
    delta: number,
    disabled: boolean,
  ) => (
    <Pressable
      onPress={() => step(itemId, delta)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={addItemsStepperLabel(delta, name)}
      accessibilityState={{ disabled }}
      style={{
        width: MIN_TAP,
        height: MIN_TAP,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: c.hair2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Mono size={15} color={c.ink} maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}>
          {label}
        </Mono>
      </View>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/*
       * React Native does NOT reposition Modal content for the software
       * keyboard, and this sheet is bottom-anchored (justifyContent:
       * 'flex-end'), so without this the iOS keyboard covers the search field,
       * the results and the "Add to order" button the instant search is
       * focused — and the only visible area left is the scrim, which closes the
       * sheet. Same wrapper move-stock-modal / cycle-count-release-sheet /
       * cycle-count-reassign-sheet use.
       */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/*
         * THE BACKDROP IS A SIBLING BEHIND THE SHEET, NEVER ITS PARENT.
         *
         * This card used to be wrapped in a `Pressable onPress={() => undefined}`
         * whose only job was to swallow taps so they did not reach the scrim and
         * close the sheet. A Pressable ancestor claims the touch responder on
         * press-DOWN, which beats the ScrollView's pan recogniser, so the item
         * list below could not be dragged at all.
         *
         * The symptom was memorable and is worth recording: the list only began
         * scrolling AFTER the user tapped the search field, because focusing the
         * TextInput handed the responder over. Reported from the floor as "it
         * doesn't let me scroll until I click on the search bar" (2026-08-14).
         *
         * Absolute-filling the scrim keeps tap-outside-to-close working while
         * leaving the content free of any responder above it. Do NOT re-nest the
         * card inside the scrim to "simplify" this.
         */}
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={requestClose}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={requestClose}
            onAccessibilityTap={requestClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
              },
            ]}
          />
          <View
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              gap: 12,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Body
                size={15}
                color={c.ink}
                accessibilityRole="header"
                maxFontSizeMultiplier={TITLE_CAP}
                style={{ flex: 1, fontFamily: FONT.display }}
              >
                Add items
              </Body>
              <Pressable
                onPress={requestClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.close}
              >
                <X size={18} color={c.ink2} />
              </Pressable>
            </View>

            {warehouseId === null ? (
              <Body size={12.5} color={c.ink3}>
                This order has no warehouse set, so items cannot be added from the app. Open it on
                the web dashboard instead.
              </Body>
            ) : (
              <>
                <Body size={12.5} color={c.ink3}>
                  Only items stocked at this order&rsquo;s warehouse can be added. An item already
                  on the order is topped up rather than listed twice.
                </Body>

                {/* The shared text box's recipe: the card fill in the stronger
                    border. A minimum height, never a fixed one: the typed words
                    stop at the input ceiling and the box grows with them. */}
                <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair2 }]}>
                  <Search size={16} color={c.ink3} strokeWidth={1.8} />
                  <TextInput
                    value={q}
                    onChangeText={setQ}
                    placeholder="Search by name, SKU, barcode"
                    placeholderTextColor={c.ink3}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    editable={!submitting}
                    accessibilityLabel="Search items to add to this order"
                    maxFontSizeMultiplier={INPUT_CAP}
                    style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
                  />
                  {q.length > 0 ? (
                    <Pressable
                      onPress={() => setQ('')}
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                      style={styles.clearSearch}
                    >
                      <X size={16} color={c.ink2} />
                    </Pressable>
                  ) : null}
                </View>

                <Card padding={0}>
                  {/*
                   * keyboardShouldPersistTaps="handled": the default ("never")
                   * makes the FIRST tap after typing dismiss the keyboard and
                   * never reach the child, so a +/− stepper or Load more silently
                   * does nothing until tapped twice. Every sibling sheet with a
                   * text input sets this.
                   */}
                  <ScrollView
                    style={{ maxHeight: listMaxHeight }}
                    keyboardShouldPersistTaps="handled"
                  >
                    {status === 'loading' ? (
                      <ActivityIndicator color={c.ink} style={{ paddingVertical: 28 }} />
                    ) : status === 'failed' ? (
                      <Body muted size={13} style={styles.listNotice}>
                        Could not load items. Check your connection and try again.
                      </Body>
                    ) : rows.length === 0 ? (
                      // Not "nothing is stocked here": order_requests are readable
                      // org-wide, but inventory_items_select AND-s
                      // user_can_access_inventory, so a viewer with orders:approve
                      // and no read grant on this warehouse gets an empty list off
                      // a fully stocked warehouse. Cover both causes and name the
                      // next step.
                      <Body muted size={13} style={styles.listNotice}>
                        {q.trim()
                          ? `No items at this warehouse match “${q.trim()}”.`
                          : 'No items are available to add here. If you expect stock at this warehouse, ask an administrator for access to it.'}
                      </Body>
                    ) : (
                      <>
                        {rows.map((row, i) => {
                          const qty = draft[row.id] ?? 0;
                          return (
                            <View
                              key={row.id}
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 12,
                                paddingHorizontal: 14,
                                paddingVertical: 12,
                                borderTopWidth: i === 0 ? 0 : 1,
                                borderTopColor: c.hair,
                              }}
                            >
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Body size={14} color={c.ink} numberOfLines={2}>
                                  {row.name}
                                </Body>
                                <Mono size={11.5} color={c.ink3} style={{ marginTop: 2 }}>
                                  {`${row.sku ? `${row.sku} · ` : ''}${row.quantityOnHand} on hand`}
                                </Mono>
                                {onOrder.has(row.id) ? (
                                  <Body size={12} color={c.ink3} style={{ marginTop: 2 }}>
                                    Already on this order — adding tops it up
                                  </Body>
                                ) : null}
                              </View>
                              {/* The steppers' 44pt frames are 6pt wider than
                                  their 32pt boxes on every side; the group
                                  gives that back (gap 8 -> 2, margin -6), so
                                  the boxes, the count and the row's height
                                  stay where they were. */}
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, margin: -6 }}>
                                {stepBtn('−', row.id, row.name, -1, qty <= 0 || submitting)}
                                <Mono
                                  size={15}
                                  color={qty > 0 ? c.ink : c.ink3}
                                  style={{ minWidth: 24, textAlign: 'center' }}
                                >
                                  {qty}
                                </Mono>
                                {stepBtn('+', row.id, row.name, 1, submitting)}
                              </View>
                            </View>
                          );
                        })}
                        {remaining > 0 ? (
                          <>
                            <Hair inset={14} />
                            <Pressable
                              onPress={() => void loadMore()}
                              disabled={loadingMore}
                              accessibilityRole="button"
                              accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
                              style={({ pressed }) => ({
                                minHeight: MIN_TAP,
                                alignItems: 'center',
                                justifyContent: 'center',
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
                  </ScrollView>
                </Card>

                <Eyebrow>{`${selectedCount} ITEM${selectedCount === 1 ? '' : 'S'} SELECTED`}</Eyebrow>

                {error ? (
                  <Body size={13} color={c.critText} accessibilityRole="alert">
                    {error}
                  </Body>
                ) : null}

                <Pressable
                  onPress={() => void submit()}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: submitting, busy: submitting }}
                  style={[styles.submit, { backgroundColor: c.ink, opacity: submitting ? 0.6 : 1 }]}
                >
                  {submitting ? <ActivityIndicator color={c.paper} /> : null}
                  <Text
                    style={[styles.submitLabel, { color: c.paper }]}
                    maxFontSizeMultiplier={ACTION_CAP}
                  >
                    Add to order
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The title stops at the display ceiling, like every sheet's title. */
const TITLE_CAP = capTo(15, TYPE_CEILING.display);
/** Typed words stop at the input ceiling (a bordered box). */
const INPUT_CAP = capTo(14, TYPE_CEILING.input);
/** Add to order's words are chrome: the control ceiling, the button grows. */
const ACTION_CAP = capTo(13, TYPE_CEILING.control);

const styles = StyleSheet.create({
  close: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: MIN_TAP,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8, paddingHorizontal: 0 },
  // The X in a 44pt frame that reaches the box's right edge; it gives back
  // the box's border top and bottom, so the box does not grow when it shows.
  clearSearch: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    marginVertical: -1,
    marginRight: -12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listNotice: { paddingHorizontal: 16, paddingVertical: 22 },
  submit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: MIN_TAP,
    borderRadius: 10,
  },
  submitLabel: { fontFamily: FONT.display, fontSize: 13, textAlign: 'center', flexShrink: 1 },
});
