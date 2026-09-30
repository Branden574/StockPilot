import { CheckCircle2, ChevronRight, Circle, X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  defaultShortfallSelection,
  READINESS_NEEDS_CONNECTION_COPY,
  SHORTFALL_PO_CANCEL_LABEL,
  SHORTFALL_PO_CLOSE_LABEL,
  SHORTFALL_PO_OPEN_DRAFT_HINT,
  SHORTFALL_PO_PHONE_REVIEW_COPY,
  SHORTFALL_PO_QUANTITY_LABEL,
  SHORTFALL_PO_SUBMIT_LABEL,
  SHORTFALL_PO_TITLE,
  shortfallIdempotencyKey,
  type ShortfallKeyState,
  type ShortfallPoView,
  type ShortfallSelection,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import { readOrderReadiness } from '@/lib/order-readiness';
import {
  adoptShortfallRefusal,
  mintShortfallKey,
  setShortfallQuantity,
  shortfallCreatedRows,
  shortfallSheetView,
  submitShortfallPo,
  toggleShortfallChoice,
  type ShortfallDraftRoute,
  type ShortfallSubmitResult,
  type ShortfallSupplierNameMap,
} from '@/lib/order-shortfall-po';
import { draftOrderShortfallPos } from '@/lib/orders-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useSheetKeyboardFields } from '@/lib/use-sheet-keyboard-fields';
import { useTheme } from '@/lib/use-theme';

/**
 * DRAFT A PO FOR WHAT THIS ORDER IS SHORT (F2-5): the phone twin of the web
 * order page's draft dialog, opened from "Draft PO for what is short" on the
 * readiness card (a manager holding purchase_orders:manage, with Orders and
 * Purchase orders on).
 *
 * One row per short item, from the readiness the screen showed when it
 * opened (core shortfallPoView): a draftable item has a checkbox (on by
 * default), "Short 12 · already on order or draft 4", its supplier ("No
 * supplier: goes on a draft without one; choose a supplier before
 * ordering.") and a quantity (at most what may be drafted); an item already
 * covered by an open PO or a draft, a kit, a deleted item or one moved to
 * another warehouse is shown unchecked and disabled, saying why. The footer
 * counts the drafts the call will make and says they are not sent. Every
 * decision and word is lib/order-shortfall-po.ts over core's (tested there).
 *
 * Draft sends the chosen lines with the request's idempotency key (core
 * shortfallIdempotencyKey: kept for a retry of the same request; dropped on
 * any edit, as on the web, so an edit changed back is a new request too), so
 * a double tap, or a retry after an answer that never came, gets the first
 * answer and never a second draft. Offline Draft is off and says it needs a
 * connection. A refusal is said in place (role alert, and announced: iOS
 * gives the 'alert' role no trait) and any edit clears it, as on the web;
 * after "Stock or POs changed since you looked" the rows show the new maxima
 * (lowered, never raised), the person's choices are kept (never lowered on
 * their behalf), and the refusal names what it unticked. Once drafted, each draft
 * is a row that opens it on the phone's PO screen, read-only: "Review and
 * order this draft on the web." Nothing here composes or sends mail.
 *
 * Mounted per open. While a request runs it cannot be dismissed, so its
 * answer is never lost. Built in the sibling-backdrop shape
 * (sheet-backdrop-guard.test.ts) inside a KeyboardAvoidingView, sized like
 * the exception sheets (never taller than the space the keyboard leaves;
 * the body gives way and scrolls), with the focused quantity kept in view
 * above the keyboard (lib/use-sheet-keyboard-fields.ts). Every checkbox,
 * field and button is its own VoiceOver element of at least 44 pt, labels
 * capped at their ceilings; the sentences are content and grow with Dynamic
 * Type.
 */
export function DraftShortfallPoSheet({
  visible,
  orderId,
  orderLabel,
  startView,
  startNotice,
  supplierNames,
  timeZone,
  offline,
  onClose,
  onDrafted,
  onOpenDraft,
  onRefresh,
}: {
  visible: boolean;
  orderId: string;
  /** "SO-000123", under the title. */
  orderLabel: string | null;
  /** The rows the sheet opened on (lib/order-shortfall-po.ts shortfallSheetOpening). */
  startView: ShortfallPoView;
  /** Core's "Stock or POs changed since you looked..." when readiness read
   *  as the sheet opened offers something else than the screen showed. */
  startNotice: string | null;
  /** The suppliers' names, read by id when the sheet opened (archived ones
   *  included); null when that read failed. */
  supplierNames: ShortfallSupplierNameMap;
  /** The organization's zone, for "Checked at". */
  timeZone: string | null;
  /** No connection: Draft is disabled, with the reason. */
  offline: boolean;
  onClose: () => void;
  /** Drafts were created (or the same request answered again): read the
   *  order behind the sheet. */
  onDrafted: () => void;
  /** Open a created draft (its PO screen, read-only for a draft). */
  onOpenDraft: (route: ShortfallDraftRoute) => void;
  /** Read the order again behind the sheet (after a refusal that may mean it moved). */
  onRefresh: () => void;
}) {
  const { c, mode } = useTheme();
  const { height } = useWindowDimensions();
  const [view, setView] = React.useState<ShortfallPoView>(startView);
  const [selection, setSelection] = React.useState<ShortfallSelection>(() => defaultShortfallSelection(startView));
  const [busy, setBusy] = React.useState(false);
  // A second tap before the re-render that disables Draft must not send a
  // second request (the key would make it a replay, but it is never sent).
  const drafting = React.useRef(false);
  // The request's key: kept while the request is the same (core
  // shortfallIdempotencyKey), dropped on ANY edit (the web's rule: an edit
  // changed back is a new request too) and after a refusal that is not the
  // same request tried again (lib/order-shortfall-po.ts: only busy, a fault
  // and no answer keep it). Read only in the Draft handler.
  const keyRef = React.useRef<ShortfallKeyState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(startNotice);
  const [closed, setClosed] = React.useState(false);
  const [created, setCreated] = React.useState<Extract<ShortfallSubmitResult, { kind: 'created' }> | null>(null);
  // THE SHEET'S SIZE: the exception sheets' rule (never taller than the
  // space the keyboard-avoiding wrapper leaves, below the status bar; the
  // body gives way and scrolls). Fixed pixel sizes, never percentages.
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  const [attachBody, kb] = useSheetKeyboardFields();
  // The body itself, to bring a refusal (its first line) into view.
  const bodyNode = React.useRef<ScrollView | null>(null);
  React.useEffect(() => {
    if (error !== null) bodyNode.current?.scrollTo({ y: 0, animated: true });
  }, [error]);
  // The web dialog's notice is a polite live region; iOS gives a Text none,
  // so it is announced when the sheet opens with it.
  React.useEffect(() => {
    if (startNotice) AccessibilityInfo.announceForAccessibility(startNotice);
  }, [startNotice]);

  const done = created !== null;
  const locked = busy || closed || done;
  const sheet = shortfallSheetView({ view, selection, supplierNames, timeZone, offline, busy, closed });
  // Nothing more to do here: drafted, refused for good, or nothing left to
  // draft. Draft goes and Cancel reads Close.
  const finished = done || closed || !sheet.offersDraft;

  function edit(next: ShortfallSelection) {
    setSelection(next);
    // Another request now: the next Draft mints its own key, and a shown
    // refusal (about the choice before this edit) goes. The web does the same.
    keyRef.current = null;
    setError(null);
  }

  function requestClose() {
    if (busy) return;
    onClose();
  }

  async function draft() {
    if (drafting.current || !sheet.canDraft) return;
    drafting.current = true;
    const lines = sheet.lines;
    keyRef.current = shortfallIdempotencyKey(keyRef.current, orderId, lines, mintShortfallKey);
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await submitShortfallPo(
      {
        draft: draftOrderShortfallPos,
        reread: (id) => readOrderReadiness(supabase, id),
      },
      { orderId, lines, key: keyRef.current, shown: view },
    );
    drafting.current = false;
    setBusy(false);
    if (result.kind === 'created') {
      setCreated(result);
      AccessibilityInfo.announceForAccessibility(result.message);
      onDrafted();
      return;
    }
    // The fresh rows with the person's choices kept, and the refusal naming
    // what it unticked (the web's words).
    const next = adoptShortfallRefusal(selection, view, result);
    setError(next.message);
    AccessibilityInfo.announceForAccessibility(next.message);
    if (result.dropKey) keyRef.current = null;
    setView(next.view);
    setSelection(next.selection);
    if (result.closed) setClosed(true);
    if (result.refresh) onRefresh();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/*
       * React Native does not move Modal content for the keyboard, and the
       * quantity fields sit low in this bottom-anchored sheet: the same
       * wrapper the needed-by and exception sheets use.
       */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent: a Pressable
         * ancestor folds the whole card into one VoiceOver element and claims
         * the touch before the body can scroll. Taps outside still close,
         * because the scrim fills the screen behind the card.
         */}
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={requestClose}
          onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={requestClose}
            onAccessibilityTap={requestClose}
            accessibilityRole="button"
            accessibilityLabel={SHORTFALL_PO_CLOSE_LABEL}
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            onStartShouldSetResponder={kb.claimTapOutside}
            onResponderRelease={kb.onTapOutside}
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              paddingBottom: 30,
              gap: 12,
              maxHeight: layout.sheetMaxHeight,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Body
                  size={16}
                  color={c.ink}
                  accessibilityRole="header"
                  maxFontSizeMultiplier={TITLE_CAP}
                  style={{ fontFamily: FONT.display }}
                >
                  {SHORTFALL_PO_TITLE}
                </Body>
                {orderLabel ? (
                  <Mono size={11} color={c.ink4}>
                    {orderLabel}
                  </Mono>
                ) : null}
              </View>
              <Pressable
                onPress={requestClose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={SHORTFALL_PO_CLOSE_LABEL}
                accessibilityState={{ disabled: busy }}
                style={{
                  minWidth: MIN_TAP,
                  minHeight: MIN_TAP,
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>

            {/* keyboardShouldPersistTaps="handled": otherwise the first tap
                after typing only dismisses the keyboard, and a checkbox or
                Draft needs a second tap. The one part that scrolls, and the
                one that gives way (flexShrink) before the title, Close or
                the buttons leave the screen. Each row sits directly in it,
                so the focused quantity's row is the one kept in view. */}
            <ScrollView
              ref={(node) => {
                attachBody(node);
                bodyNode.current = node;
              }}
              style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={kb.onBodyScroll}
              onLayout={kb.onBodyLayout}
              onContentSizeChange={kb.onBodyContentSizeChange}
              contentContainerStyle={{ gap: 12 }}
            >
              {/* A refusal first, where the body is scrolled to when it
                  appears (announced too: iOS gives the alert role no trait). */}
              {error ? (
                <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
                  {error}
                </Body>
              ) : null}
              {notice && !error && !created ? (
                <Body size={13} color={ACCENT.warn}>
                  {notice}
                </Body>
              ) : null}

              {created ? (
                <>
                  <Body size={14.5} color={c.ink}>
                    {created.message}
                  </Body>
                  {shortfallCreatedRows(created.result, supplierNames).map((r) => (
                    <Pressable
                      key={r.purchaseOrderId}
                      onPress={() => onOpenDraft(r.route)}
                      accessibilityRole="button"
                      accessibilityLabel={r.accessibilityLabel}
                      accessibilityHint={SHORTFALL_PO_OPEN_DRAFT_HINT}
                      style={[styles.createdRow, { borderColor: c.hair }]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Mono size={13} color={c.ink}>
                          {r.label}
                        </Mono>
                        <Body size={12.5} color={c.ink3}>
                          {r.supplier}
                        </Body>
                      </View>
                      <ChevronRight size={18} color={c.ink4} />
                    </Pressable>
                  ))}
                  <Body size={13} color={c.ink3}>
                    {SHORTFALL_PO_PHONE_REVIEW_COPY}
                  </Body>
                </>
              ) : (
                <>
                  {sheet.unavailable && sheet.unavailable !== error ? (
                    <Body size={13.5} color={ACCENT.warn}>
                      {sheet.unavailable}
                    </Body>
                  ) : null}
                  {sheet.rows.map((row) => (
                    <View
                      key={row.itemId}
                      onLayout={(e) => kb.onRowLayout(row.itemId, e)}
                      style={[styles.row, { borderTopColor: c.hair }]}
                    >
                      {/* The checkbox is the row's one VoiceOver element for
                          the item: its name, numbers and supplier (core's
                          sentence). The quantity field sits beside it, never
                          inside it. */}
                      <Pressable
                        onPress={() => edit(toggleShortfallChoice(selection, view, row.itemId))}
                        disabled={!row.draftable || locked}
                        accessibilityRole="checkbox"
                        accessibilityLabel={row.accessibilityLabel}
                        accessibilityState={{ checked: row.checked, disabled: !row.draftable || locked }}
                        style={styles.check}
                      >
                        <View style={{ paddingTop: 2 }}>
                          {row.checked ? (
                            <CheckCircle2 size={22} color={c.ink} strokeWidth={2} />
                          ) : (
                            <Circle size={22} color={c.ink4} strokeWidth={1.6} />
                          )}
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Body size={14.5} color={c.ink}>
                            {row.name}
                          </Body>
                          {row.sku ? (
                            <Mono size={11} color={c.ink4}>
                              {row.sku}
                            </Mono>
                          ) : null}
                          <Body size={13} color={c.ink2}>
                            {row.detail}
                          </Body>
                          {row.supplier ? (
                            <Body size={12.5} color={c.ink3}>
                              {row.supplier}
                            </Body>
                          ) : null}
                        </View>
                      </Pressable>
                      {row.draftable ? (
                        <FieldLabel>{SHORTFALL_PO_QUANTITY_LABEL}</FieldLabel>
                      ) : null}
                      {row.draftable ? (
                        <TextInput
                          value={row.quantity}
                          onChangeText={(t) => edit(setShortfallQuantity(selection, view, row.itemId, t))}
                          onFocus={() => kb.onFieldFocus(row.itemId)}
                          onBlur={() => kb.onFieldBlur(row.itemId)}
                          onLayout={(e) => kb.onFieldLayout(row.itemId, e)}
                          keyboardType="decimal-pad"
                          editable={row.checked && !locked}
                          accessibilityLabel={row.quantityAccessibilityLabel}
                          accessibilityHint={row.quantityAccessibilityHint}
                          accessibilityState={{ disabled: !row.checked || locked }}
                          maxFontSizeMultiplier={INPUT_CAP}
                          style={[
                            styles.input,
                            {
                              borderColor: row.problem ? ACCENT.warn : c.hair,
                              backgroundColor: c.paper2,
                              color: c.ink,
                              opacity: row.checked ? 1 : 0.5,
                            },
                          ]}
                        />
                      ) : null}
                      {row.problem ? (
                        <Body size={12.5} color={ACCENT.warn}>
                          {row.problem}
                        </Body>
                      ) : null}
                    </View>
                  ))}
                  {sheet.hiddenNote ? (
                    <Body size={12.5} color={c.ink3}>
                      {sheet.hiddenNote}
                    </Body>
                  ) : null}
                  <Body size={12} muted>
                    {sheet.checkedAt}
                  </Body>
                  {/* How many drafts, and that none is sent (core's words). */}
                  {sheet.footer ? (
                    <Body size={12.5} color={c.ink3}>
                      {sheet.footer}
                    </Body>
                  ) : null}
                </>
              )}
            </ScrollView>

            {offline && !finished ? (
              <Body size={12.5} muted>
                {READINESS_NEEDS_CONNECTION_COPY}
              </Body>
            ) : null}

            {finished ? null : (
              <Pressable
                onPress={() => void draft()}
                disabled={!sheet.canDraft}
                accessibilityRole="button"
                accessibilityLabel={SHORTFALL_PO_SUBMIT_LABEL}
                accessibilityState={{ disabled: !sheet.canDraft, busy }}
                accessibilityHint={sheet.draftBlockedBy ?? undefined}
                style={[
                  styles.action,
                  { backgroundColor: c.ink, opacity: sheet.canDraft || busy ? 1 : 0.5 },
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={c.paper} />
                ) : (
                  <Mono size={13} color={c.paper} maxFontSizeMultiplier={ACTION_CAP}>
                    {SHORTFALL_PO_SUBMIT_LABEL}
                  </Mono>
                )}
              </Pressable>
            )}
            <Pressable
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={finished ? SHORTFALL_PO_CLOSE_LABEL : SHORTFALL_PO_CANCEL_LABEL}
              accessibilityState={{ disabled: busy }}
              style={[styles.action, { borderWidth: 1, borderColor: c.hair, opacity: busy ? 0.5 : 1 }]}
            >
              <Mono size={13} color={c.ink} maxFontSizeMultiplier={ACTION_CAP}>
                {finished ? SHORTFALL_PO_CLOSE_LABEL : SHORTFALL_PO_CANCEL_LABEL}
              </Mono>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The title stops at the display ceiling, like every sheet's title. */
const TITLE_CAP = capTo(16, TYPE_CEILING.display);
/** Button labels are chrome: they stop growing at the control ceiling, and
 *  the button grows with them (minHeight). */
const ACTION_CAP = capTo(13, TYPE_CEILING.control);
/** Typed text stops at the input ceiling (a bordered box). */
const INPUT_CAP = capTo(15, TYPE_CEILING.input);

const styles = StyleSheet.create({
  row: {
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  check: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    minHeight: MIN_TAP,
  },
  input: {
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.mono,
    fontSize: 15,
  },
  createdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: MIN_TAP,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: MIN_TAP,
    borderRadius: 10,
  },
});
