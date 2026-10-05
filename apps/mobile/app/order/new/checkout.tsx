import { type Href, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  CART_MANAGER_NOTES_LABEL_COPY,
  CART_MANAGER_NOTES_PLACEHOLDER_COPY,
  CART_NEEDED_BY_HINT_COPY,
  CART_NEEDED_BY_LABEL_COPY,
  CART_OPTIONAL_COPY,
  CART_SUBMIT_FINE_PRINT_COPY,
  CHECKOUT_DELIVERY_COPY,
  CHECKOUT_PICKUP_COPY,
  ORDER_NOTES_MAX,
  REVIEW_SUBMIT_COPY,
  REVIEW_SUBTITLE_COPY,
  REVIEW_TITLE_COPY,
  STOREFRONT_BACK_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_CHOOSE_SITE_COPY,
  STOREFRONT_DELIVER_TO_COPY,
  STOREFRONT_FOR_COPY,
  STOREFRONT_FOR_NOW_MYSELF_COPY,
  STOREFRONT_PICKUP_OR_DELIVERY_COPY,
  STOREFRONT_SHIP_FROM_COPY,
  checkoutNotesCounterCopy,
  checkoutNotesCounterSpokenCopy,
  neededByZoneNote,
  storefrontPickupHintCopy,
  type CartAction,
} from '@stockpilot/core';

import { CartPanel } from '@/components/order-storefront/cart-panel';
import { Segmented, SetupRow } from '@/components/order-storefront/controls';
import { NeededBySheet, QuantitySheet, RequesterSheet, SiteSheet } from '@/components/order-storefront/sheets';
import { StorefrontState } from '@/components/order-storefront/storefront-state';
import { UnconfirmedPanel } from '@/components/order-storefront/unconfirmed-panel';
import { IconChip } from '@/components/ui/row';
import { Body, Display, FieldLabel } from '@/components/ui/text';
import { MISSING_VALUE, lineChangeAnnouncement, notesCounterAnnouncement, quantityAnnouncement } from '@/lib/order-storefront/a11y';
import {
  checkoutStage,
  forRowView,
  itemNameFrom,
  neededByRowValue,
  showNotesCounter,
  storefrontNeededByZone,
} from '@/lib/order-storefront/checkout';
import { MIN_TAP, NOTES_FIELD_HEIGHT, STOREFRONT_GUTTER, storefrontLayout } from '@/lib/order-storefront/layout';
import { createNotesDraft, type NotesDraft } from '@/lib/order-storefront/notes-draft';
import { storefrontOutcome } from '@/lib/order-storefront/outcome';
import { storefrontSession, useOffline, useStorefront, useStorefrontScope } from '@/lib/order-storefront/runtime';
import { requesterRowValue, siteAddressLines, siteLabel } from '@/lib/order-storefront/setup';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

type CheckoutSheet = { kind: 'quantity'; itemId: string } | { kind: 'for' } | { kind: 'site' } | { kind: 'needed-by' } | null;

/**
 * CHECKOUT, WHICH IS ALSO THE REVIEW ON THE PHONE (phone ordering PO-4, plan
 * decision 6): the lines, Ship from, For (only for someone who may order on
 * behalf: the server's canOrderOnBehalf, the effective orders:approve),
 * Pickup or Delivery and the site, Needed by (the shared F2-4 picker, in the
 * organization's zone), Manager notes, and one "Submit order request".
 *
 * Opening it reads the catalog again and says in one notice what stock moved
 * (session.openCheckout). Submit needs a connection and says why it cannot be
 * pressed (its hint and the line under it). A send writes its pending record
 * BEFORE it leaves and locks everything here until the key is settled
 * (lib/order-storefront/submit.ts); the unconfirmed panel offers Check and
 * finish, Don't send it and See my orders. A placed order replaces this
 * screen with the success screen, so Back never returns to a spent checkout.
 * A refusal is said in place (a role alert, announced).
 */
export default function Checkout() {
  useStorefrontScope();
  const snap = useStorefront();
  const session = storefrontSession();
  const offline = useOffline();
  const router = useRouter();
  const focused = useIsFocused();
  const { c } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const layout = storefrontLayout({ width, fontScale });
  const [sheet, setSheet] = React.useState<CheckoutSheet>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Manager notes are typed in the field and committed to the cart by this
  // draft (a pause, blur, Submit, leaving), so a keystroke never redraws
  // every storefront screen (desk check F8.1).
  const [notesDraft] = React.useState(() => createNotesDraft({ session }));
  React.useEffect(() => () => notesDraft.dispose(), [notesDraft]);
  // Manager notes stay in view above the keyboard (simulator walk D3): the
  // body is scrolled to the note when the keyboard takes its space, the
  // helper the exception and needed-by sheets use.
  const [attachBody, kb] = useSheetKeyboard();

  useFocusEffect(
    React.useCallback(() => {
      void session.openCheckout();
      // Leaving checkout: what it said (a refusal, the withdrawn notice, a
      // refused change) has been read, so it is not shown again on return.
      return () => session.dismissOutcome();
    }, [session]),
  );

  // A placed order: the success screen, in place of this one (it says the
  // order number itself, once it is shown).
  const placedId = snap?.placed?.order.id ?? null;
  React.useEffect(() => {
    if (!placedId || !focused) return;
    router.replace('/order/new/placed' as Href);
  }, [placedId, focused, router]);

  // How a send ended (a final refusal, withdrawn, the device could not save
  // it) or a change refused, said in place and announced on this screen
  // while it is the one shown (lib/order-storefront/outcome.ts).
  const itemName = React.useMemo(() => itemNameFrom(snap?.itemMap ?? new Map()), [snap?.itemMap]);
  const ready = snap?.setup.status === 'ready' ? snap.setup.answer : null;
  const warehouse = ready?.warehouses.find((w) => w.id === snap?.warehouseId) ?? null;
  const outcome = snap ? storefrontOutcome(snap, { itemName, warehouseName: warehouse?.name ?? null }) : null;
  const outcomeText = outcome?.text ?? null;
  React.useEffect(() => {
    if (outcomeText && focused) AccessibilityInfo.announceForAccessibility(outcomeText);
  }, [outcomeText, focused]);
  // The stock that moved under the cart (read when checkout opens), said
  // while this screen is in view: a role alert does nothing on iOS (PO-4
  // review).
  const noticeText = snap?.notice ?? null;
  React.useEffect(() => {
    if (noticeText && focused) AccessibilityInfo.announceForAccessibility(noticeText);
  }, [noticeText, focused]);

  // The For line a read of the answer can bring (approve revoked while the
  // app stayed open: Submit dims and the line says why), said while in view.
  const forDetail =
    snap?.setup.status === 'ready' && snap.cart
      ? forRowView({ canOrderOnBehalf: snap.setup.answer.viewer.canOrderOnBehalf, onBehalfOf: snap.cart.onBehalfOf, lockHint: snap.locked ? STOREFRONT_CART_LOCKED_COPY : undefined }).detail
      : null;
  React.useEffect(() => {
    if (forDetail && focused) AccessibilityInfo.announceForAccessibility(forDetail);
  }, [forDetail, focused]);

  // The answer read again on open (or after a refusal for permission) can
  // come back turned off, refused or with no answer: checkout then says why in
  // place, with the outcome and the panel, never a spinner that does not end
  // (PO-4 review). What replaced the screen is announced while it is shown.
  const stage = checkoutStage(snap);
  const setupMessage =
    snap && snap.setup.status !== 'ready' && snap.setup.status !== 'loading' ? snap.setup.message : null;
  // A setup message with the outcome's own words was said already (D10).
  React.useEffect(() => {
    if (setupMessage && focused && setupMessage !== outcomeText) AccessibilityInfo.announceForAccessibility(setupMessage);
  }, [setupMessage, focused, outcomeText]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/order/new' as Href);
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await session.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const topBar = (
    <View style={styles.topbar}>
      <IconChip icon={ArrowLeft} onPress={leave} accessibilityLabel={STOREFRONT_BACK_COPY} minTap />
    </View>
  );

  // A stepper or Remove in checkout's cart: the change, then what the line is
  // now, announced (as the catalog does; desk check F7.4).
  const changeLine = (action: Extract<CartAction, { type: 'inc' | 'dec' | 'remove' }>) => {
    if (session.dispatch(action) !== null) return;
    const said = lineChangeAnnouncement(session.getSnapshot(), action.itemId);
    if (said) AccessibilityInfo.announceForAccessibility(said);
  };

  if (stage === 'unavailable' && snap) {
    return (
      <StorefrontState
        topBar={topBar}
        title={REVIEW_TITLE_COPY}
        setup={snap.setup.status === 'ready' ? { status: 'loading' } : snap.setup}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        outcome={outcome}
        panel={
          <UnconfirmedPanel
            state={snap.submission.state}
            busy={snap.submission.busy}
            offline={offline}
            warehouseName={null}
            itemName={itemName}
            onCheckAndFinish={() => void session.checkAndFinish()}
            onDontSend={() => void session.dontSend()}
            onSeeOrders={() => router.push('/orders' as Href)}
          />
        }
      />
    );
  }

  // Nothing to show yet: the answer loading, or the cart not read yet.
  if (stage === 'loading' || !snap || !ready || !snap.cart) {
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <SafeAreaView edges={['top']}>{topBar}</SafeAreaView>
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      </View>
    );
  }

  const cart = snap.cart;
  const locked = snap.locked;
  const lockHint = locked ? STOREFRONT_CART_LOCKED_COPY : undefined;
  const sites = snap.catalog.answer?.sites ?? null;
  const site = sites?.status === 'ok' ? (sites.sites.find((s) => s.id === cart.charterId) ?? null) : null;
  const zone = storefrontNeededByZone(ready.orgTimezone);
  const blockedBy = session.submitBlockedBy(offline);
  const firstSendOut = snap.submission.state.phase === 'sending' && snap.submission.state.pending.sends === 1;
  // A cart for someone else waits for the answer being read (checkout just
  // opened, or a stale focus): Submit is busy until it lands (PO-4 review).
  const waitingForAnswer = snap.checkingAnswer && cart.onBehalfOf !== null;
  const sending = firstSendOut || waitingForAnswer;
  const quantityItem = sheet?.kind === 'quantity' ? snap.itemMap.get(sheet.itemId) : undefined;
  // For follows the answer shown (canOrderOnBehalf, the effective
  // orders:approve): a cart kept for someone else by a person who no longer
  // may is said in a visible line, Submit waits, and a tap sets Myself.
  const forRow = forRowView({ canOrderOnBehalf: ready.viewer.canOrderOnBehalf, onBehalfOf: cart.onBehalfOf, lockHint });

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        {topBar}
      </SafeAreaView>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          ref={attachBody}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={kb.onBodyScroll}
          onLayout={kb.onBodyLayout}
          onContentSizeChange={kb.onBodyContentSizeChange}
          contentContainerStyle={{ alignItems: 'center' }}
        >
          {/* The column starts at the top of the content, so the note block's
              place in the column is its place in the body (the reveal). */}
          <View style={{ width: layout.readingWidth, gap: 16, paddingTop: 8, paddingBottom: 48 }}>
            <View style={{ gap: 6 }}>
              <Display size={28} accessibilityRole="header">
                {REVIEW_TITLE_COPY}
              </Display>
              <Body size={13.5} color={c.ink3}>
                {REVIEW_SUBTITLE_COPY}
              </Body>
            </View>

            <UnconfirmedPanel
              state={snap.submission.state}
              busy={snap.submission.busy}
              offline={offline}
              warehouseName={warehouse?.name ?? null}
              itemName={itemName}
              onCheckAndFinish={() => void session.checkAndFinish()}
              onDontSend={() => void session.dontSend()}
              onSeeOrders={() => router.push('/orders' as Href)}
            />
            {outcome ? (
              <Body size={14} color={outcome.tone === 'calm' ? c.ink : c.critText} accessibilityRole="alert">
                {outcome.text}
              </Body>
            ) : null}
            {snap.notice ? (
              <Body size={13.5} color={c.warnText} accessibilityRole="alert">
                {snap.notice}
              </Body>
            ) : null}

            <CartPanel
              cart={cart}
              itemMap={snap.itemMap}
              notOrderable={snap.notOrderable}
              refusals={snap.refusals}
              locked={locked}
              usuals={[]}
              onInc={(itemId) => changeLine({ type: 'inc', itemId })}
              onDec={(itemId) => changeLine({ type: 'dec', itemId })}
              onQuantity={(itemId) => setSheet({ kind: 'quantity', itemId })}
              onRemove={(itemId) => changeLine({ type: 'remove', itemId })}
              onAdd={(itemId) => void session.dispatch({ type: 'add', itemId, quantity: 1 })}
              onClear={() => void session.dispatch({ type: 'clear' })}
            />

            <SetupRow label={STOREFRONT_SHIP_FROM_COPY} value={warehouse?.name || MISSING_VALUE} />
            {forRow.shown ? (
              <SetupRow
                label={STOREFRONT_FOR_COPY}
                value={requesterRowValue(cart.onBehalfOf)}
                detail={forRow.detail}
                disabled={locked}
                hint={forRow.hint}
                onPress={() => {
                  if (forRow.tap === 'choose') {
                    setSheet({ kind: 'for' });
                    return;
                  }
                  if (session.dispatch({ type: 'set-setup', patch: { onBehalfOf: null } }) === null) {
                    AccessibilityInfo.announceForAccessibility(STOREFRONT_FOR_NOW_MYSELF_COPY);
                  }
                }}
              />
            ) : null}

            <View style={{ gap: 8 }}>
              <FieldLabel>{STOREFRONT_PICKUP_OR_DELIVERY_COPY}</FieldLabel>
              <Segmented
                label={STOREFRONT_PICKUP_OR_DELIVERY_COPY}
                options={[
                  { value: 'pickup', label: CHECKOUT_PICKUP_COPY },
                  { value: 'delivery', label: CHECKOUT_DELIVERY_COPY },
                ]}
                value={cart.fulfillmentType}
                disabled={locked}
                hint={lockHint}
                onChange={(method) =>
                  // Switching to Pickup clears the site (the web storefront's rule).
                  void session.dispatch({
                    type: 'set-setup',
                    patch: method === 'pickup' ? { fulfillmentType: 'pickup', charterId: null } : { fulfillmentType: 'delivery' },
                  })
                }
              />
              {cart.fulfillmentType === 'pickup' ? (
                <Body size={13} color={c.ink3}>
                  {storefrontPickupHintCopy(warehouse?.name ?? '')}
                </Body>
              ) : (
                <SetupRow
                  label={STOREFRONT_DELIVER_TO_COPY}
                  value={site ? siteLabel(site) : STOREFRONT_CHOOSE_SITE_COPY}
                  detail={site ? siteAddressLines(site.address).join(', ') || null : null}
                  disabled={locked}
                  hint={lockHint}
                  onPress={() => setSheet({ kind: 'site' })}
                />
              )}
            </View>

            <View style={{ gap: 6 }}>
              {zone.ok ? (
                <>
                  <SetupRow
                    label={CART_NEEDED_BY_LABEL_COPY}
                    value={neededByRowValue(cart.neededBy, zone.zone)}
                    detail={CART_NEEDED_BY_HINT_COPY}
                    disabled={locked}
                    hint={lockHint}
                    onPress={() => setSheet({ kind: 'needed-by' })}
                  />
                  <Body size={12.5} color={c.ink3}>
                    {neededByZoneNote(zone.zone)}
                  </Body>
                </>
              ) : (
                <>
                  <FieldLabel>{CART_NEEDED_BY_LABEL_COPY}</FieldLabel>
                  <Body size={13} color={c.ink3}>
                    {zone.message}
                  </Body>
                </>
              )}
            </View>

            <NotesField
              key={`${snap.scope?.orgId ?? ''}:${snap.warehouseId ?? ''}`}
              initial={cart.notes}
              locked={locked}
              lockHint={lockHint}
              draft={notesDraft}
              keyboard={kb}
            />

            <View style={{ gap: 8 }}>
              {locked ? null : (
                <Pressable
                  onPress={() => {
                    // What is typed in the notes goes into the cart first.
                    notesDraft.flush();
                    void session.submit(offline);
                  }}
                  disabled={blockedBy !== null || sending}
                  accessibilityRole="button"
                  accessibilityLabel={REVIEW_SUBMIT_COPY}
                  accessibilityHint={blockedBy ?? undefined}
                  accessibilityState={{ disabled: blockedBy !== null || sending, busy: sending }}
                  style={[
                    styles.submit,
                    { backgroundColor: c.ink, opacity: blockedBy === null || sending ? 1 : 0.5 },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator color={c.paper} />
                  ) : (
                    <Body size={15.5} color={c.paper} maxFontSizeMultiplier={ACTION_CAP} style={{ fontFamily: FONT.display }}>
                      {REVIEW_SUBMIT_COPY}
                    </Body>
                  )}
                </Pressable>
              )}
              {blockedBy && !locked ? (
                <Body size={13} color={c.ink3}>
                  {blockedBy}
                </Body>
              ) : null}
              <Body size={12.5} color={c.ink3}>
                {CART_SUBMIT_FINE_PRINT_COPY}
              </Body>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {quantityItem ? (
        <QuantitySheet
          item={quantityItem}
          quantity={cart.lines.find((l) => l.itemId === quantityItem.id)?.quantity ?? 0}
          onClose={() => setSheet(null)}
          onSave={(value) => {
            const refused = session.setQuantity(quantityItem.id, value);
            setSheet(null);
            if (!refused) AccessibilityInfo.announceForAccessibility(quantityAnnouncement(quantityItem.name, value));
          }}
        />
      ) : null}
      {sheet?.kind === 'for' ? (
        <RequesterSheet
          current={cart.onBehalfOf}
          requesters={ready.recentRequesters}
          onClose={() => setSheet(null)}
          onPick={(who) => {
            setSheet(null);
            void session.dispatch({ type: 'set-setup', patch: { onBehalfOf: who } });
          }}
        />
      ) : null}
      {sheet?.kind === 'site' ? (
        <SiteSheet
          sites={sites}
          current={cart.charterId}
          onClose={() => setSheet(null)}
          onPick={(id) => {
            setSheet(null);
            void session.dispatch({ type: 'set-setup', patch: { charterId: id } });
          }}
        />
      ) : null}
      {sheet?.kind === 'needed-by' && zone.ok ? (
        <NeededBySheet
          zone={zone.zone}
          currentWall={cart.neededBy}
          serverSkewMs={snap.serverSkewMs}
          zoneNote={neededByZoneNote(zone.zone)}
          onClose={() => setSheet(null)}
          onSet={(wall) => {
            setSheet(null);
            void session.dispatch({ type: 'set-needed-by', value: wall });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Manager notes: the field keeps what is typed (uncontrolled, as the search
 * box is: a busy JS thread never drops a keystroke) and hands each change to
 * the draft, which commits it to the cart (lib/order-storefront/notes-
 * draft.ts). Keyed by organization and warehouse, so another cart's notes
 * start a new field. Only this field redraws per keystroke (its counter).
 */
function NotesField({
  initial,
  locked,
  lockHint,
  draft,
  keyboard,
}: {
  initial: string;
  locked: boolean;
  lockHint: string | undefined;
  draft: NotesDraft;
  /** The body's keyboard helper: the note reports where it sits and when it
   *  has focus, and the body keeps it in view. */
  keyboard: ReturnType<typeof useSheetKeyboard>[1];
}) {
  const { c } = useTheme();
  const [text, setText] = React.useState(initial);
  const counter = showNotesCounter(text) ? checkoutNotesCounterCopy(Array.from(text).length, ORDER_NOTES_MAX) : null;
  // The counter is said in words when it first shows and when the note is
  // full (the field then stops taking characters), never per keystroke.
  const lengthRef = React.useRef(initial.length);
  return (
    <View style={{ gap: 6 }} onLayout={keyboard.onNoteBlockLayout}>
      <FieldLabel>{`${CART_MANAGER_NOTES_LABEL_COPY} · ${CART_OPTIONAL_COPY}`}</FieldLabel>
      <TextInput
        defaultValue={initial}
        onChangeText={(value) => {
          const before = lengthRef.current;
          lengthRef.current = value.length;
          const said = notesCounterAnnouncement(before, value.length, ORDER_NOTES_MAX);
          if (said) AccessibilityInfo.announceForAccessibility(said);
          setText(value);
          draft.change(value);
        }}
        onFocus={keyboard.onNoteFocus}
        onBlur={() => {
          draft.flush();
          keyboard.onNoteBlur();
        }}
        onLayout={keyboard.onNoteLayout}
        multiline
        maxLength={ORDER_NOTES_MAX}
        editable={!locked}
        placeholder={CART_MANAGER_NOTES_PLACEHOLDER_COPY}
        placeholderTextColor={c.ink4}
        accessibilityLabel={CART_MANAGER_NOTES_LABEL_COPY}
        accessibilityHint={lockHint}
        maxFontSizeMultiplier={INPUT_CAP}
        style={[styles.notes, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
      />
      {/* The counter's line is kept from the start (blank, and hidden from
          VoiceOver, until 1,800), so the block shown above the keyboard
          never grows under it (simulator walk D5). */}
      <Body
        size={12}
        color={c.ink3}
        accessibilityLabel={counter ? checkoutNotesCounterSpokenCopy(Array.from(text).length, ORDER_NOTES_MAX) : undefined}
        accessibilityElementsHidden={counter === null}
        importantForAccessibility={counter ? 'auto' : 'no-hide-descendants'}
      >
        {counter ?? ' '}
      </Body>
    </View>
  );
}

const INPUT_CAP = capTo(15, TYPE_CEILING.input);
const ACTION_CAP = capTo(15.5, TYPE_CEILING.control);

const styles = StyleSheet.create({
  topbar: { paddingHorizontal: 9 + STOREFRONT_GUTTER - 20, paddingTop: 5, flexDirection: 'row', alignItems: 'center' },
  notes: {
    height: NOTES_FIELD_HEIGHT,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  submit: {
    minHeight: Math.max(MIN_TAP, 52),
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
});
