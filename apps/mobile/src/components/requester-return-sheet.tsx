import { X } from 'lucide-react-native';
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
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_ERROR_WORDS,
  RETURN_EXCHANGE_NOTE_MAX,
  RETURN_NOTES_MAX,
  RETURNS_COPY,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { ReplacementQuantityStepper } from '@/components/replacement-quantity-stepper';
import { Button } from '@/components/ui/button';
import { CachedImage } from '@/components/ui/cached-image';
import { Modal } from '@/components/ui/modal';
import { Body, Eyebrow, FieldLabel, Mono } from '@/components/ui/text';
import { PHOTO_BACKGROUND } from '@/components/ui/tones';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import { RETURN_REASONS } from '@/lib/order-returns';
import {
  buildRequesterReturnBody,
  chooseRequesterOption,
  draftWantsSizes,
  forgetRequesterDraft,
  openRequesterDraft,
  reconcileDraftWithOptions,
  reconcileRequesterDraft,
  rememberRequesterDraft,
  requesterEntryWords,
  requesterExchangesOn,
  requesterLineAvailability,
  requesterLineExchangeView,
  requesterLineLabel,
  requesterLoadedSheet,
  requesterPhotoUrl,
  requesterReplacementQuantity,
  requesterReplacementQuantityOf,
  setRequesterMode,
  setRequesterNote,
  setRequesterNotes,
  setRequesterReplacementQuantity,
  stepRequesterQuantity,
  toggleRequesterReason,
  type RequesterDraft,
  type RequesterDraftScope,
  type RequesterOptionsState,
  type RequesterSheetLoad,
} from '@/lib/requester-returns';
import {
  getRequesterExchangeOptions,
  requesterDraftAfterRefusal,
  sendRequesterReturn,
} from '@/lib/requester-returns-api';
import { capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

const TITLE_CAP = capTo(16, TYPE_CEILING.display);
const CONTROL_CAP = capTo(15, TYPE_CEILING.control);
const CHOICE_CAP = capTo(13, TYPE_CEILING.control);
const INPUT_CAP = capTo(15, TYPE_CEILING.input);
/** The block id of the request's own notes (every other block is a line's note). */
const NOTES_BLOCK = '__notes';

interface RequesterSheetProps {
  orderId: string;
  /** Whose draft this is (the account and organization), for the memory draft. */
  scope: RequesterDraftScope | null;
  /** The order screen's read of the sheet (use-requester-return.ts). */
  load: RequesterSheetLoad;
  online: boolean;
  /** Read the sheet again (Try again, or a refusal that means it is behind). */
  onReloadSheet: () => void;
  onClose: () => void;
  /** The server answered the request: the screen closes this sheet, says so and reads the order again. */
  onSent: (sent: { returnNumber: string | null; exchange: boolean }) => void;
}

/**
 * "Return or exchange" on a member's OWN completed order, on the phone and
 * the iPad (returns RX-3, plan RX-3 Phone; brief 6, 27, 30). The web token
 * page's form, natively:
 *
 *   - RETURNING: each line that can still come back, with its photo, name and
 *     size ("2 of 3 returnable") and a stepper from 0 to what is left;
 *   - "What would you like to do?": Return only, or Exchange for another
 *     size (only while exchanges are on, and once the line has a quantity);
 *   - REPLACEMENT: the line's other sizes, loaded ONCE for the order on the
 *     first Exchange (photo, size, "Available" or "Not in stock right now",
 *     never a count), as radio buttons; a line with no other size offers
 *     "Request a different replacement: warehouse will review." and a note.
 *     The replacement's quantity follows the line's (brief 4) and, when more
 *     than one comes back, has its own stepper from 1 to that (the web's);
 *   - an optional reason and notes, then Submit return request (core's
 *     words, the token page's and the portal's).
 *
 * The server decides everything again (brief 6): what is eligible, every
 * quantity, the item. ONLINE ONLY: offline the sizes are not asked for and
 * Send is disabled with "Needs a connection." (no outbox kind exists for a
 * return). The draft lives in memory for this app session
 * (requester-returns.ts), with ONE request key minted when the sheet first
 * opens for the order and kept until the request is answered.
 *
 * Structure: the exception sheets' (a sibling backdrop behind a plain card,
 * accessibilityViewIsModal, onAccessibilityTap on the scrim, the title and
 * the button pinned, one scrolling body sized by exceptionSheetLayout, the
 * keyboard handled by useSheetKeyboard with each note's block directly in
 * the body). At the AX text sizes every row stacks (shouldStackRow), item
 * names are never capped, and on the iPad each line's RETURNING and
 * REPLACEMENT sit side by side (they wrap on the phone). Mounted per opening,
 * so every opening starts from the remembered draft. Nothing here can be
 * dismissed while a request is under way.
 *
 * The look (redesign P5.7b): the per-mode palette; Return only / Exchange
 * and the reasons as the reference's chips (the ink fill with the page
 * colour's words when chosen, the stronger border round the secondary ink
 * when not; DESIGN-SPEC 6.6), each a 44pt target; the size rows as controls
 * with the stronger border, the chosen one the ink edge on the recessed
 * fill; photos on the white photo ground (6.14); the text boxes on the
 * shared Field's recipe, their typed words in the body face; "Not in stock
 * right now" in the mode's warning ink (the web's warning dot); refusals in
 * its refusal ink.
 */
export function RequesterReturnSheet(props: RequesterSheetProps) {
  const { c, mode } = useTheme();
  const { orderId, scope, load, online, onReloadSheet, onClose, onSent } = props;
  const sheet = requesterLoadedSheet(load);
  const { height, fontScale } = useWindowDimensions();
  const stacked = shouldStackRow(fontScale);
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({ windowHeight: height, availableHeight, topInset: insets.top });
  const [attachBody, kb] = useSheetKeyboard();
  // Where each note's block sits in the body, and the field in its block
  // (their own onLayout), so the focused one is scrolled into view.
  const spans = React.useRef(new Map<string, { block?: { top: number; height: number }; field?: { top: number; height: number } }>());

  const [draft, setDraft] = React.useState<RequesterDraft | null>(() =>
    sheet ? openRequesterDraft({ scope, orderId, sheet }) : null,
  );
  // A sheet that arrives (or is read again) while this is open: the draft is
  // checked against it, its key kept (reset during render, not in an effect).
  const [seenSheet, setSeenSheet] = React.useState(sheet);
  if (seenSheet !== sheet) {
    setSeenSheet(sheet);
    if (sheet) setDraft((d) => (d ? reconcileRequesterDraft(d, sheet) : openRequesterDraft({ scope, orderId, sheet })));
  }
  const [options, setOptions] = React.useState<RequesterOptionsState>({ state: 'idle' });
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The draft is kept in memory as it changes (never on the device).
  React.useEffect(() => {
    if (draft) rememberRequesterDraft(scope, orderId, draft);
  }, [draft, scope, orderId]);

  React.useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);
  // iOS does not announce a role 'alert' that appears: the sheet's own read
  // failing is announced, as a refusal is.
  const loadMessage = load.state === 'failed' ? load.message : load.state === 'closed' ? RETURN_ERROR_WORDS.orderNotFound : null;
  React.useEffect(() => {
    if (loadMessage) AccessibilityInfo.announceForAccessibility(loadMessage);
  }, [loadMessage]);

  const exchangesOn = sheet ? requesterExchangesOn(sheet, options) : false;
  const wantsSizes = !!draft && exchangesOn && draftWantsSizes(draft);

  const loadSizes = React.useCallback(async () => {
    setOptions({ state: 'loading' });
    try {
      const answer = await getRequesterExchangeOptions(orderId);
      setOptions({ state: 'ready', answer });
      // A size no longer offered is unchosen; exchanges turned off, every line a return only.
      setDraft((d) => (d ? reconcileDraftWithOptions(d, answer) : d));
    } catch {
      setOptions({ state: 'failed', message: RETURNS_COPY.requesterOptionsUnavailable });
    }
  }, [orderId]);

  // The sizes load ONCE, on the first Exchange (or on opening a draft that
  // already asks for one), and only online. A failure waits for Try again.
  React.useEffect(() => {
    if (!wantsSizes || !online || options.state !== 'idle') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on the first Exchange: the loading state is set before the request; the answer is set after it
    void loadSizes();
  }, [wantsSizes, online, options.state, loadSizes]);

  const close = () => {
    if (sending) return;
    onClose();
  };

  function change(next: RequesterDraft) {
    setDraft(next);
    setError(null);
  }

  async function send() {
    if (!draft || !sheet || sending || !online) return;
    const built = buildRequesterReturnBody({ sheet, draft, options, exchangesOn });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const answer = await sendRequesterReturn(orderId, built.body);
      // Answered (a new request, or the replay of the one a lost answer hid):
      // the draft is done; the next opening starts a new one with a new key.
      forgetRequesterDraft(scope, orderId);
      onSent({ returnNumber: answer.returnNumber, exchange: built.exchange });
    } catch (e) {
      // One rule with the web form (core requesterRefusalRecovery; RX-3 fix
      // round 1, F3): a key used with other details means the earlier send
      // went through, so the draft starts over with nothing chosen and a new
      // key; a sheet that is behind is read again with the sizes, and the
      // draft (its key kept) is checked against both.
      const after = requesterDraftAfterRefusal(draft, e);
      setError(after.message);
      if (after.draft !== draft) setDraft(after.draft);
      if (after.reload) {
        setOptions({ state: 'idle' });
        onReloadSheet();
      }
    } finally {
      setSending(false);
    }
  }

  const sizesLoading = wantsSizes && (options.state === 'loading' || (options.state === 'idle' && online));
  const disabledReason = !online ? READINESS_NEEDS_CONNECTION_COPY : null;
  const canSend = online && !sending && !!draft && !!sheet && sheet.lines.length > 0 && !sizesLoading;
  const scrim = mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)';

  const noteFocus = (blockId: string) => {
    const span = spans.current.get(blockId);
    kb.onSpanFocus(span?.block ?? null, span?.field ?? null);
  };
  const laidBlock = (blockId: string, top: number, h: number) => {
    spans.current.set(blockId, { ...spans.current.get(blockId), block: { top, height: h } });
  };
  const laidField = (blockId: string, top: number, h: number) => {
    spans.current.set(blockId, { ...spans.current.get(blockId), field: { top, height: h } });
  };

  const choiceStyle = (on: boolean) => ({
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: MIN_TAP,
    justifyContent: 'center' as const,
    borderColor: on ? c.ink : c.hair2,
    backgroundColor: on ? c.ink : 'transparent',
  });

  const body: React.ReactNode[] = [];
  if (load.state === 'closed') {
    // The server's one answer for an order this person may not ask about
    // from here (it went away, Returns was turned off).
    body.push(
      <Body key="closed" size={14} color={c.ink}>
        {RETURN_ERROR_WORDS.orderNotFound}
      </Body>,
    );
  } else if (!sheet || !draft) {
    body.push(
      load.state === 'failed' ? (
        <View key="failed" style={{ gap: 10 }}>
          <Body size={14} color={c.ink} accessibilityRole="alert">
            {load.message}
          </Body>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button
              variant="outline"
              size="sm"
              disabled={!online}
              style={{ minHeight: MIN_TAP }}
              onPress={onReloadSheet}
            >
              Try again
            </Button>
          </View>
        </View>
      ) : (
        <ActivityIndicator
          key="loading"
          color={c.ink}
          style={{ marginVertical: 24 }}
          accessible
          accessibilityLabel={RETURNS_COPY.requesterLoadingForm}
        />
      ),
    );
  } else if (sheet.lines.length === 0) {
    body.push(
      <Body key="nothing" size={14} color={c.ink}>
        {RETURNS_COPY.requesterNothingLeft}
      </Body>,
    );
  } else {
    if (load.state === 'failed') {
      body.push(
        <View key="stale" style={{ gap: 8 }}>
          <Body size={13} color={c.ink3}>
            {load.message}
          </Body>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button
              variant="outline"
              size="sm"
              disabled={!online}
              style={{ minHeight: MIN_TAP }}
              onPress={onReloadSheet}
            >
              Try again
            </Button>
          </View>
        </View>,
      );
    }
    if (sheet.exchangesEnabled && !exchangesOn) {
      // The switch was turned off since the sheet was read: every line is a return only.
      body.push(
        <Body key="switch" size={13} color={c.ink}>
          {RETURNS_COPY.exchangeKillSwitch}
        </Body>,
      );
    }
    for (const l of sheet.lines) {
      const lineId = l.orderRequestLineId;
      const d = draft.lines[lineId] ?? { quantity: 0, mode: 'return' as const, itemId: null, note: '', replacementQuantity: null };
      const label = requesterLineLabel(l);
      const photo = requesterPhotoUrl(l.photo);
      const exchanging = exchangesOn && d.quantity > 0 && d.mode === 'exchange';
      const view = exchanging ? requesterLineExchangeView(options, lineId, online) : null;
      const replacementQuantity = requesterReplacementQuantityOf(d);
      const stepButton = (glyph: string, delta: number, off: boolean) => (
        <Pressable
          onPress={() => {
            const next = stepRequesterQuantity(draft, l, delta);
            change(next);
            // iOS ignores accessibilityLiveRegion (Android only): the new count
            // is announced (RX-3 fix round 1, L4).
            AccessibilityInfo.announceForAccessibility(`${next.lines[lineId]?.quantity ?? 0} ${label} returning`);
          }}
          disabled={off}
          accessibilityRole="button"
          accessibilityLabel={`${delta < 0 ? 'Return one fewer' : 'Return one more'} ${label}`}
          accessibilityState={{ disabled: off }}
          style={{
            minWidth: MIN_TAP,
            minHeight: MIN_TAP,
            paddingHorizontal: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.hair2,
            backgroundColor: c.card,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: off ? 0.35 : 1,
          }}
        >
          <Mono size={15} color={c.ink} maxFontSizeMultiplier={CONTROL_CAP}>
            {glyph}
          </Mono>
        </Pressable>
      );
      body.push(
        <View key={lineId} style={[styles.lineBlock, { borderBottomColor: c.hair }]}>
          <View style={styles.pair}>
            {/* RETURNING: what goes back (a text label, never colour alone). */}
            <View style={[styles.side, { borderColor: c.hair }]}>
              {/* RETURNING only on a line that comes back, as on the web (RX-3 fix round 1, L4). */}
              {d.quantity > 0 ? <Eyebrow>{RETURNS_COPY.returning}</Eyebrow> : null}
              <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 12 }}>
                {/* The photo on the white photo ground in both modes; none, a
                    recessed square in its place (DESIGN-SPEC 6.14). */}
                {photo ? (
                  <CachedImage
                    uri={photo}
                    style={[
                      styles.photo,
                      { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair },
                    ]}
                  />
                ) : (
                  <View style={[styles.photo, { backgroundColor: c.sunk, borderColor: c.hair }]} />
                )}
                <View style={stacked ? { gap: 2 } : { flex: 1, minWidth: 0, gap: 2 }}>
                  {/* An item's name is never capped (the app's policy). */}
                  <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
                    {label}
                  </Body>
                  <Mono size={11} color={c.ink3}>
                    {requesterLineAvailability(l)}
                  </Mono>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {stepButton('−', -1, d.quantity <= 0 || sending)}
                <Mono
                  size={15}
                  color={c.ink}
                  style={{ minWidth: 24, textAlign: 'center' }}
                  accessibilityLabel={`${d.quantity} ${label} returning`}
                  accessibilityLiveRegion="polite"
                >
                  {d.quantity}
                </Mono>
                {stepButton('+', 1, d.quantity >= l.quantityRemaining || sending)}
              </View>
              {exchangesOn && d.quantity > 0 ? (
                <View
                  style={{ gap: 6 }}
                  accessibilityRole="radiogroup"
                  accessibilityLabel={`${RETURNS_COPY.whatWouldYouLikeToDo} ${label}`}
                >
                  <Body size={13} muted>
                    {RETURNS_COPY.whatWouldYouLikeToDo}
                  </Body>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {(
                      [
                        ['return', RETURNS_COPY.returnOnly],
                        ['exchange', RETURNS_COPY.exchangeRequester],
                      ] as const
                    ).map(([choice, words]) => {
                      const on = d.mode === choice;
                      return (
                        <Pressable
                          key={choice}
                          onPress={() => change(setRequesterMode(draft, lineId, choice))}
                          disabled={sending}
                          accessibilityRole="radio"
                          accessibilityLabel={words}
                          accessibilityState={{ checked: on, disabled: sending }}
                          style={choiceStyle(on)}
                        >
                          <Body
                            size={13}
                            color={on ? c.paper : c.ink2}
                            maxFontSizeMultiplier={CHOICE_CAP}
                          >
                            {words}
                          </Body>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}
            </View>
            {view ? (
              // REPLACEMENT: what comes instead (an arrow and a text label, and
              // an ink edge, never colour alone).
              <View style={[styles.side, { borderColor: c.hair, borderLeftWidth: 4, borderLeftColor: c.ink }]}>
                {/* Read as the word alone, never "right arrow" (RX-3 fix round 1, L4). */}
                <Eyebrow accessibilityLabel={RETURNS_COPY.replacement}>→ {RETURNS_COPY.replacement}</Eyebrow>
                {(view.kind === 'options' || view.kind === 'review') && d.quantity > 1 ? (
                  <ReplacementQuantityStepper
                    value={replacementQuantity}
                    max={d.quantity}
                    label={label}
                    disabled={sending}
                    onChange={(n) => change(setRequesterReplacementQuantity(draft, lineId, n))}
                  />
                ) : (
                  <Body size={13} muted>
                    {requesterReplacementQuantity(replacementQuantity)}
                  </Body>
                )}
                {view.kind === 'loading' ? (
                  <ActivityIndicator
                    color={c.ink}
                    accessible
                    accessibilityLabel={RETURNS_COPY.requesterLoadingSizes}
                  />
                ) : null}
                {view.kind === 'offline' ? (
                  <Body size={13} muted>
                    {RETURNS_COPY.needsConnection}
                  </Body>
                ) : null}
                {view.kind === 'failed' ? (
                  <View style={{ gap: 8 }}>
                    <Body size={13} color={c.ink}>
                      {view.message}
                    </Body>
                    <View style={{ alignSelf: 'flex-start' }}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!online || sending}
                        style={{ minHeight: MIN_TAP }}
                        onPress={() => void loadSizes()}
                      >
                        Try again
                      </Button>
                    </View>
                  </View>
                ) : null}
                {view.kind === 'review' ? (
                  <Body size={13.5} color={c.ink}>
                    {RETURNS_COPY.warehouseReview}
                  </Body>
                ) : null}
                {view.kind === 'options' ? (
                  <View
                    style={{ gap: 6 }}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={`${RETURNS_COPY.replacementSiblings} for ${label}`}
                  >
                    {view.rows.map((row) => {
                      const checked = d.itemId === row.itemId;
                      return (
                        <Pressable
                          key={row.itemId}
                          onPress={() => change(chooseRequesterOption(draft, lineId, row.itemId))}
                          disabled={sending}
                          accessibilityRole="radio"
                          accessibilityLabel={row.accessibilityLabel}
                          accessibilityState={{ checked, disabled: sending }}
                          style={[
                            styles.option,
                            {
                              flexDirection: stacked ? 'column' : 'row',
                              alignItems: stacked ? 'stretch' : 'center',
                              borderColor: checked ? c.ink : c.hair2,
                              backgroundColor: checked ? c.sunk : 'transparent',
                              minHeight: MIN_TAP,
                            },
                          ]}
                        >
                          {row.photoUrl ? (
                            <CachedImage
                              uri={row.photoUrl}
                              style={[
                                styles.optionPhoto,
                                { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair },
                              ]}
                            />
                          ) : (
                            <View
                              style={[
                                styles.optionPhoto,
                                { backgroundColor: c.sunk, borderColor: c.hair },
                              ]}
                            />
                          )}
                          <View style={stacked ? { gap: 2 } : { flex: 1, minWidth: 0, gap: 2 }}>
                            <Body size={14} color={c.ink}>
                              {row.label}
                            </Body>
                            <Body size={12.5} color={row.available ? c.ink3 : c.warnText}>
                              {row.availability}
                            </Body>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>,
      );
      if (view?.kind === 'review') {
        // The note sits directly in the body, so the keyboard can show it.
        const count = Array.from(d.note.trim()).length;
        body.push(
          <View
            key={`${lineId}-note`}
            style={{ gap: 6 }}
            onLayout={(e) => laidBlock(lineId, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
          >
            <FieldLabel>{RETURNS_COPY.warehouseReviewNote}</FieldLabel>
            <TextInput
              value={d.note}
              onChangeText={(t) => change(setRequesterNote(draft, lineId, t))}
              onFocus={() => noteFocus(lineId)}
              onBlur={kb.onNoteBlur}
              onLayout={(e) => laidField(lineId, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
              editable={!sending}
              multiline
              maxLength={RETURN_EXCHANGE_NOTE_MAX}
              maxFontSizeMultiplier={INPUT_CAP}
              placeholderTextColor={c.ink3}
              accessibilityLabel={`${RETURNS_COPY.warehouseReviewNote}, ${label}`}
              style={[
                styles.input,
                { borderColor: c.hair2, backgroundColor: c.card, color: c.ink },
              ]}
            />
            <Mono size={11} color={count > RETURN_EXCHANGE_NOTE_MAX ? c.critText : c.ink3}>
              {`${count} / ${RETURN_EXCHANGE_NOTE_MAX}`}
            </Mono>
          </View>,
        );
      }
    }
    body.push(
      <View key="reason" style={{ gap: 8 }}>
        <Eyebrow>REASON</Eyebrow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Reason">
          {RETURN_REASONS.map((r) => {
            const on = draft.reasonCode === r.value;
            return (
              <Pressable
                key={r.value}
                // Optional: tapping the chosen reason again clears it.
                onPress={() => change(toggleRequesterReason(draft, r.value))}
                disabled={sending}
                accessibilityRole="radio"
                accessibilityLabel={r.label}
                accessibilityState={{ checked: on, disabled: sending }}
                style={choiceStyle(on)}
              >
                <Body
                  size={13}
                  color={on ? c.paper : c.ink2}
                  maxFontSizeMultiplier={CHOICE_CAP}
                >
                  {r.label}
                </Body>
              </Pressable>
            );
          })}
        </View>
      </View>,
      <View
        key="notes"
        style={{ gap: 6 }}
        onLayout={(e) => laidBlock(NOTES_BLOCK, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      >
        <FieldLabel>NOTES</FieldLabel>
        <TextInput
          value={draft.notes}
          onChangeText={(t) => change(setRequesterNotes(draft, t))}
          onFocus={() => noteFocus(NOTES_BLOCK)}
          onBlur={kb.onNoteBlur}
          onLayout={(e) => laidField(NOTES_BLOCK, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
          editable={!sending}
          multiline
          maxLength={RETURN_NOTES_MAX}
          maxFontSizeMultiplier={INPUT_CAP}
          placeholder={RETURNS_COPY.requesterNotesPlaceholder}
          placeholderTextColor={c.ink3}
          accessibilityLabel={RETURNS_COPY.requesterNotesLabel}
          style={[styles.input, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }]}
        />
      </View>,
    );
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={close}
            onAccessibilityTap={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[StyleSheet.absoluteFill, { backgroundColor: scrim }]}
          />
          <View
            onStartShouldSetResponder={kb.claimTapOutside}
            onResponderRelease={kb.onTapOutside}
            style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}
          >
            <View style={styles.header}>
              <View style={{ flex: 1, gap: 2 }}>
                <Body
                  size={16}
                  color={c.ink}
                  accessibilityRole="header"
                  maxFontSizeMultiplier={TITLE_CAP}
                  style={{ fontFamily: FONT.display }}
                >
                  {requesterEntryWords(load)}
                </Body>
                {sheet?.orderNumber ? (
                  <Mono size={11} color={c.ink3}>
                    {sheet.orderNumber}
                  </Mono>
                ) : null}
              </View>
              <Pressable
                onPress={close}
                disabled={sending}
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityState={{ disabled: sending }}
                style={{ minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'flex-end', justifyContent: 'center' }}
              >
                <X size={18} color={c.ink3} />
              </Pressable>
            </View>

            <ScrollView
              ref={attachBody}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={kb.onBodyScroll}
              onLayout={kb.onBodyLayout}
              onContentSizeChange={kb.onBodyContentSizeChange}
              contentContainerStyle={{ gap: 12 }}
              // At the AX sizes the body takes all the room the bounded sheet
              // leaves between the title and Send (it shrinks to fit).
              style={{ maxHeight: stacked ? undefined : Math.max(layout.bodyMaxHeight, 380), flexShrink: 1 }}
            >
              {body}
            </ScrollView>

            {error ? (
              <Body size={13} color={c.critText} accessibilityRole="alert">
                {error}
              </Body>
            ) : null}
            {disabledReason ? (
              <Body size={13} color={c.ink3}>
                {disabledReason}
              </Body>
            ) : null}
            <Button
              block
              disabled={!canSend}
              accessibilityHint={disabledReason ?? undefined}
              wrap
              onPress={() => void send()}
            >
              {sending ? RETURNS_COPY.requesterSending : RETURNS_COPY.requesterSubmit}
            </Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 32, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineBlock: { gap: 10, paddingBottom: 12, borderBottomWidth: 1 },
  // RETURNING and REPLACEMENT side by side on the iPad; on the phone they wrap.
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  side: { flexGrow: 1, flexBasis: 300, gap: 10, borderWidth: 1, borderRadius: 12, padding: 12 },
  photo: { width: 64, height: 64, borderRadius: 10, borderWidth: 1 },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  optionPhoto: { width: 44, height: 44, borderRadius: 8, borderWidth: 1 },
  // A typed note: the shared text box's recipe, in the body face.
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
