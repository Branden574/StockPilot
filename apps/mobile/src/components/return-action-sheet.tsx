import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  choiceFromKey,
  choiceKey,
  damagedHint,
  exchangeReviewHeaderLabel,
  exchangeReviewOptions,
  isChoiceOffered,
  qtyReturningLabel,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_REASON_MAX,
  RETURN_ERROR_WORDS,
  RETURN_RELEASE_REASON_MAX,
  RETURNS_COPY,
  releaseOutcomeLine,
  replacementSiteOptions,
  restockOptionRows,
  returnLineLabel,
  type ExchangeReviewState,
  type RestockChoice,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { ReplacementPickerList } from '@/components/replacement-picker-list';
import { ReplacementQuantityStepper } from '@/components/replacement-quantity-stepper';
import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import {
  cancelReturn,
  cancelReturnReplacement,
  changeReturnReplacement,
  declineReturnReplacement,
  denyReturn,
  describeReturnError,
  getReturnCandidates,
  planReturnDispositions,
  releaseReturnReplacement,
  returnErrorReason,
  runReturnSteps,
  type MobileReturnWorkbench,
  type MobileReturnWorkbenchLine,
} from '@/lib/returns-api';
import {
  allChoicesOffered,
  approvalDecision,
  cancelReplacementMessage,
  changedDecisions,
  choiceFor,
  choiceProblems,
  denyHelp,
  exchangeApprovalDecisions,
  exchangeOf,
  exchangeReviewProblems,
  exchangeReviewStateFor,
  exchangeSheetConsequences,
  exchangeWhatHappens,
  initialChoices,
  itemPhotoUrl,
  lineLabel,
  openLines,
  processButtonLabel,
  processingHint,
  refusalRefreshesWorkbench,
  replacementQuantityMax,
  reviewsForShortChange,
  shortBackorderLabel,
  shortItemLabel,
  shortSentences,
  shownReplacementStatus,
  stepOutcomeMessage,
  whatHappensLines,
} from '@/lib/returns-view';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

const TITLE_CAP = capTo(16, TYPE_CEILING.display);
const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);

export type ReturnSheetMode =
  | 'approve'
  | 'process'
  | 'destination'
  | 'deny'
  | 'cancel'
  // RX-2: the replacement.
  | 'release'
  | 'cancel_replacement'
  | 'change_replacement'
  | 'issue_replacement'
  // Desk check F9: the exchange ends for good after a replacement cancel.
  | 'close_as_return_only';

type AddState = { itemId: string | null; label: string | null; quantity: number; free: number | null } | null;

export interface ReturnSheetDone {
  message: string;
  workbench: MobileReturnWorkbench | null;
}

/**
 * The RMA workbench's sheets on the phone (returns RX-1): Approve (the
 * destination per line and "The item is here", off unless the RMA was created
 * at the counter), Process return (the destination re-checked, the button
 * named after the rack), Change destination, Deny (a reason, required) and
 * Cancel return (a reason, optional). One component, five modes.
 *
 * ONLINE ONLY: the submit button follows the LIVE `online` prop; turning on
 * airplane mode with the sheet open disables it with "Needs a connection."
 * Nothing is queued. A request under way cannot be dismissed (Close, the
 * backdrop, the VoiceOver escape and Android's back button), so its answer is
 * never lost; a lost answer is recovered by sending the same body again (the
 * steps route replays it).
 *
 * The destination rows come from core's restock-view (the server's
 * provenance answer); a rack that failed revalidation is shown disabled with
 * its reason, Staging is always one tap away, and Scrap hides the
 * destination group (brief 10). The rows are radio buttons with their
 * state, so VoiceOver reads "Return to original rack: 31-C, radio button,
 * selected"; a disabled row carries its reason in its label (a hint is not
 * read when hints are off). A planned rack that is gone opens with NO
 * destination chosen and a sentence naming the line and why; the button
 * stays disabled until a valid choice is made (plan 3.5.4, returns review).
 * When a process step is refused because the rack is gone, the answer's
 * workbench replaces the sheet's choices the same way and the refusal is
 * shown in place and announced; the person chooses and confirms again.
 *
 * Structure: the exception sheets' (sibling backdrop behind a plain card,
 * accessibilityViewIsModal, onAccessibilityTap on the scrim, the body the one
 * part that scrolls, sized by exceptionSheetLayout, the keyboard handled by
 * useSheetKeyboard).
 */
export function ReturnActionSheet({
  visible,
  mode,
  workbench,
  online,
  onClose,
  onDone,
}: {
  visible: boolean;
  mode: ReturnSheetMode;
  workbench: MobileReturnWorkbench;
  online: boolean;
  onClose: () => void;
  onDone: (done: ReturnSheetDone) => void;
}) {
  const busyRef = React.useRef(false);
  function requestCloseIfIdle() {
    if (busyRef.current) return;
    onClose();
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestCloseIfIdle}>
      <SheetContent
        key={`${String(visible)}:${mode}`}
        busyRef={busyRef}
        mode={mode}
        initialWorkbench={workbench}
        online={online}
        onClose={onClose}
        onDone={onDone}
      />
    </Modal>
  );
}

function SheetContent({
  busyRef,
  mode,
  initialWorkbench,
  online,
  onClose,
  onDone,
}: {
  busyRef: React.MutableRefObject<boolean>;
  mode: ReturnSheetMode;
  initialWorkbench: MobileReturnWorkbench;
  online: boolean;
  onClose: () => void;
  onDone: (done: ReturnSheetDone) => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [wb, setWb] = React.useState(initialWorkbench);
  const [choices, setChoices] = React.useState<Record<string, RestockChoice>>(() => initialChoices(initialWorkbench));
  const [itemIsHere, setItemIsHere] = React.useState(initialWorkbench.createdOnCounter);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // RX-2: the exchange review at approval, "Add a replacement", the short
  // refusal's numbers, and the change/issue picks.
  const [reviews, setReviews] = React.useState<Record<string, ExchangeReviewState>>({});
  const [adds, setAdds] = React.useState<Record<string, AddState>>({});
  const [shortDetail, setShortDetail] = React.useState<unknown>(null);
  const [picks, setPicks] = React.useState<Record<string, { itemId: string | null; quantity: number; label?: string }>>({});
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({ windowHeight: height, availableHeight, topInset: insets.top });
  const [attachBody, kb] = useSheetKeyboard();
  // Review fix P7: where the review and each of its cards sit in the body,
  // and each card's heading, so "Change replacement" after a short refusal
  // can scroll to the first short line and move VoiceOver there.
  const bodyNode = React.useRef<ScrollView | null>(null);
  const reviewTop = React.useRef(0);
  const reviewCardTop = React.useRef<Record<string, number>>({});
  const reviewHeading = React.useRef<Record<string, View | null>>({});

  React.useEffect(() => {
    busyRef.current = false;
  }, [busyRef]);
  React.useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  function setBusy(v: boolean) {
    busyRef.current = v;
    setSubmitting(v);
  }
  function requestClose() {
    if (submitting) return;
    onClose();
  }
  // Review fix S2: a refusal that means the screen is behind the server
  // (another person changed the return, or its replacement was picked or
  // left meanwhile: replacement_in_progress) closes the sheet; the workbench
  // reloads and its notice says why, instead of offering the old actions.
  function staleRefusal(e: unknown): boolean {
    if (!refusalRefreshesWorkbench(returnErrorReason(e))) return false;
    onDone({ message: describeReturnError(e), workbench: null });
    return true;
  }

  const lines = openLines(wb);
  const ex = exchangeOf(wb);
  // Review fix P2: what happens to the replacement (Cancel return, Cancel,
  // Change and Issue a new replacement), in core's words.
  const consequences = exchangeSheetConsequences(mode, wb);
  const needsDestinations = mode === 'approve' || mode === 'process' || mode === 'destination';
  // Desk check F6: after replacement_site_not_available the sheet asks where
  // the replacement goes (the warehouse's sites, or pickup) and sends again.
  const [sitePrompt, setSitePrompt] = React.useState(false);
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  // RX-2 simulator finding SIM-5: the question in the body says why the site
  // was refused, so the refusal is announced for VoiceOver but not pinned as a
  // second line beside "Choose where the replacement goes." (with the title,
  // the two lines left the body no room for the sites on an iPhone at AX5).
  function askSite(words: string) {
    setSitePrompt(true);
    setError(null);
    AccessibilityInfo.announceForAccessibility(words);
  }
  const siteOptions = replacementSiteOptions(ex.deliverySites ?? []);
  const siteValue = sitePrompt ? (siteOptions.find((o) => o.key === siteKey)?.value ?? null) : null;
  const reasonText = reason.trim();
  const reasonCount = Array.from(reasonText).length;
  // A reason is required to deny, to cancel an RMA whose exchange was
  // approved, and for every replacement action.
  const reasonRequired =
    mode === 'deny' ||
    mode === 'release' ||
    mode === 'cancel_replacement' ||
    mode === 'change_replacement' ||
    mode === 'issue_replacement' ||
    mode === 'close_as_return_only' ||
    (mode === 'cancel' && ex.hasApprovedExchange);
  const reasonMax = mode === 'release' ? RETURN_RELEASE_REASON_MAX : RETURN_REASON_MAX;
  const reasonValid = reasonRequired ? reasonCount >= 1 && reasonCount <= reasonMax : reasonCount <= reasonMax;
  const choicesValid = !needsDestinations || allChoicesOffered(wb, choices);
  // One sentence per line that needs a destination, naming it.
  const problems = needsDestinations ? choiceProblems(wb, choices) : [];
  // Review fix P1: the review is every returns manager's (without order
  // approval it starts at, and allows only, the decline), so its problems
  // and decisions always count.
  const exchangeProblems = mode === 'approve' ? exchangeReviewProblems(wb, reviews, adds) : [];
  // The lines a change (approved) or a re-issue (cancelled by a replacement cancel) acts on.
  const changeLines =
    mode === 'change_replacement' || mode === 'issue_replacement'
      ? ex.lines.filter((x) => (mode === 'issue_replacement' ? x.status === 'cancelled' && x.approvedItemId : x.status === 'approved'))
      : [];
  const pickFor = (x: (typeof changeLines)[number]) =>
    picks[x.id] ?? { itemId: x.approvedItemId ?? x.requestedItemId, quantity: x.approvedQuantity ?? x.requestedQuantity };
  const picksValid = changeLines.every((x) => pickFor(x).itemId);
  const disabledReason = !online
    ? READINESS_NEEDS_CONNECTION_COPY
    : !choicesValid
      ? (problems.join(' ') || RETURNS_COPY.chooseDestination)
      : exchangeProblems.length > 0
        ? exchangeProblems.join(' ')
        : !picksValid
          ? RETURNS_COPY.chooseReplacement
          : sitePrompt && !siteValue
            ? RETURNS_COPY.chooseSite
            : !reasonValid
              ? reasonRequired && reasonCount === 0
                ? RETURNS_COPY.reasonRequired
                : `At most ${reasonMax} characters.`
              : null;
  const canSubmit = disabledReason === null && !submitting;
  const shortLines = shortSentences(shortDetail, (id) => shortItemLabel(wb, reviews, adds, id, picks));

  // Review fix P7: after a short refusal, "Change replacement" switches each
  // short line's review to Change replacement (its picker opens) and scrolls
  // to the first, moving VoiceOver to its heading. The lines above the first
  // do not change, so where it sits now is where it stays.
  function changeShortLines() {
    const next = reviewsForShortChange(wb, reviews, shortDetail, adds);
    setReviews(next.reviews);
    setShortDetail(null);
    setError(null);
    const first = next.focusIds[0];
    if (!first) return;
    const y = reviewTop.current + (reviewCardTop.current[first] ?? 0);
    bodyNode.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    const target = reviewHeading.current[first];
    if (target) AccessibilityInfo.sendAccessibilityEvent(target, 'focus');
  }
  const loaderFor = (orderRequestLineId: string) => (q: string) => getReturnCandidates(wb.return.id, orderRequestLineId, q);

  const hasExchange = ex.kind === 'exchange';
  // Verification L3: a viewer who can only decline the exchange approves the return.
  const approvesExchange = hasExchange && wb.viewer.canApproveOrders;
  const title =
    mode === 'approve'
      ? approvesExchange
        ? RETURNS_COPY.approveReturnAndExchange
        : RETURNS_COPY.approveReturn
      : mode === 'process'
        ? RETURNS_COPY.processReturn
        : mode === 'destination'
          ? RETURNS_COPY.changeDestination
          : mode === 'deny'
            ? 'Deny this return?'
            : mode === 'release'
              ? RETURNS_COPY.releaseEarly
              : mode === 'cancel_replacement'
                ? `${RETURNS_COPY.cancelReplacement}?`
                : mode === 'change_replacement'
                  ? RETURNS_COPY.changeReplacement
                  : mode === 'issue_replacement'
                    ? RETURNS_COPY.issueNewReplacement
                    : mode === 'close_as_return_only'
                      ? `${RETURNS_COPY.closeAsReturnOnly}?`
                      : 'Cancel this return?';
  const cta =
    mode === 'approve'
      ? itemIsHere
        ? RETURNS_COPY.approveAndReceive
        : approvesExchange
          ? RETURNS_COPY.approveReturnAndExchange
          : RETURNS_COPY.approveReturn
      : mode === 'process'
        ? processButtonLabel(wb, choices)
        : mode === 'destination'
          ? 'Save destination'
          : mode === 'deny'
            ? RETURNS_COPY.deny
            : mode === 'release'
              ? RETURNS_COPY.releaseBeforeReturn
              : mode === 'cancel_replacement'
                ? RETURNS_COPY.cancelReplacement
                : mode === 'change_replacement'
                  ? RETURNS_COPY.changeReplacement
                  : mode === 'issue_replacement'
                    ? RETURNS_COPY.issueNewReplacement
                    : mode === 'close_as_return_only'
                      ? RETURNS_COPY.closeAsReturnOnly
                      : RETURNS_COPY.cancelReturn;

  async function submit(whenShort: 'refuse' | 'backorder' = 'refuse') {
    if (!canSubmit) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    const id = wb.return.id;
    try {
      // RX-2: the replacement actions, one route each.
      if (mode === 'release') {
        // The live replacement this sheet shows (desk check F7).
        const shown = exchangeOf(wb).replacement;
        const shownOrderId = shown?.live ? shown.orderId : null;
        if (!shownOrderId) {
          // Nothing was sent: the sheet is free again (it can be closed, or
          // the person reloads), never stuck on "Saving…".
          setError(RETURN_ERROR_WORDS.returnChanged);
          setBusy(false);
          return;
        }
        const res = await releaseReturnReplacement(id, shownOrderId, reasonText);
        onDone({
          message: releaseOutcomeLine(res.answer),
          workbench: res.workbench,
        });
        return;
      }
      if (mode === 'close_as_return_only') {
        const res = await declineReturnReplacement(id, { expectedRevision: wb.revision, reason: reasonText });
        onDone({ message: res.answer.changed ? RETURNS_COPY.closedAsReturnOnly : 'Nothing to close.', workbench: res.workbench });
        return;
      }
      if (mode === 'cancel_replacement') {
        // Verification V1: the status this sheet's warnings came from; the
        // notice says what to do with what was picked or sent.
        const res = await cancelReturnReplacement(id, { expectedRevision: wb.revision, reason: reasonText, shownStatus: shownReplacementStatus(wb) });
        onDone({ message: cancelReplacementMessage(res.answer), workbench: res.workbench });
        return;
      }
      if (mode === 'change_replacement' || mode === 'issue_replacement') {
        try {
          const res = await changeReturnReplacement(id, {
            expectedRevision: wb.revision,
            lines: changeLines.map((x) => ({ exchangeLineId: x.id, itemId: pickFor(x).itemId, quantity: pickFor(x).quantity })),
            reason: reasonText,
            whenShort,
            ...(siteValue ? { replacement: siteValue } : {}),
          });
          onDone({
            message: mode === 'issue_replacement' ? 'New replacement issued.' : 'Replacement changed.',
            workbench: res.workbench,
          });
        } catch (e) {
          if (staleRefusal(e)) return;
          if (returnErrorReason(e) === 'replacement_unavailable') {
            // The numbers first (D19); then "Approve, replacement on backorder".
            const detail = (e as { details?: { detail?: unknown } }).details?.detail;
            setShortDetail(detail ?? []);
          }
          if (returnErrorReason(e) === 'replacement_site_not_available') askSite(describeReturnError(e));
          else setError(describeReturnError(e));
          setBusy(false);
        }
        return;
      }
      if (mode === 'approve' || mode === 'process') {
        const changed = changedDecisions(wb, choices);
        // Always the decisions the review holds (review fix P1), so a
        // refusal reads as it does on the web.
        const exchange = mode === 'approve' ? exchangeApprovalDecisions(wb, reviews, adds) : [];
        const res = await runReturnSteps(id, {
          steps: [mode === 'approve' ? 'approve' : 'process'],
          expectedRevision: wb.revision,
          expectedPlanSeq: wb.planSeq,
          ...(mode === 'approve'
            ? {
                approve: {
                  ...approvalDecision(wb, choices),
                  ...(exchange.length > 0 ? { exchange, replacement: { whenShort, ...(siteValue ?? {}) } } : {}),
                },
                receiveNow: itemIsHere,
              }
            : { process: changed.length > 0 ? { lines: changed } : null }),
        });
        const step = res.ran[0];
        if (step && step.outcome === 'refused' && step.reason === 'replacement_site_not_available') {
          // Desk check F6: ask where the replacement goes, then send again.
          askSite(stepOutcomeMessage(step, res.workbench, itemIsHere));
          setBusy(false);
          return;
        }
        if (step && step.outcome === 'refused' && step.reason === 'replacement_unavailable') {
          setShortDetail(step.detail ?? []);
          setError(stepOutcomeMessage(step, res.workbench, itemIsHere));
          setBusy(false);
          return;
        }
        if (step && step.outcome === 'refused') {
          // The rack went away (or someone else moved first): redraw from the
          // answer and keep the sheet open for another choice.
          setWb(res.workbench);
          setChoices(initialChoices(res.workbench));
          setError(stepOutcomeMessage(step, res.workbench, itemIsHere));
          setBusy(false);
          return;
        }
        onDone({
          message: step ? stepOutcomeMessage(step, res.workbench, itemIsHere) : 'Saved.',
          workbench: res.workbench,
        });
        return;
      }
      if (mode === 'destination') {
        const changed = changedDecisions(wb, choices);
        if (changed.length > 0) await planReturnDispositions(id, changed);
        onDone({ message: changed.length > 0 ? 'Destination saved.' : 'Nothing changed.', workbench: null });
        return;
      }
      if (mode === 'deny') {
        const res = await denyReturn(id, reasonText);
        onDone({ message: res.changed ? 'Return denied.' : 'Already denied.', workbench: null });
        return;
      }
      const res = await cancelReturn(id, { expectedRevision: wb.revision, reason: reasonText || null });
      onDone({ message: res.changed ? 'Return cancelled.' : 'Already cancelled.', workbench: null });
      return;
    } catch (e) {
      if (staleRefusal(e)) return;
      setError(describeReturnError(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
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
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' }]}
        />
        <View
          onStartShouldSetResponder={kb.claimTapOutside}
          onResponderRelease={kb.onTapOutside}
          style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}
        >
          <View style={styles.header}>
            <Body
              size={16}
              color={c.ink}
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_CAP}
              style={{ fontFamily: FONT.display, flex: 1 }}
            >
              {title}
            </Body>
            <Pressable
              onPress={requestClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: submitting }}
              style={{ minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'flex-end', justifyContent: 'center' }}
            >
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          <ScrollView
            ref={(node) => {
              attachBody(node);
              bodyNode.current = node;
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            onScroll={kb.onBodyScroll}
            onLayout={kb.onBodyLayout}
            onContentSizeChange={kb.onBodyContentSizeChange}
            contentContainerStyle={{ gap: 14 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            {wb.return.returnNumber ? (
              <Mono size={12} color={c.ink4}>
                {wb.return.returnNumber}
              </Mono>
            ) : null}

            {/* Review fix P2: what happens to the replacement, first, so it is
                read before the reason is typed. What to do with picked items
                (Staging, the driver) is announced as an alert. */}
            {consequences.map((t) => (
              <Body
                key={t.key}
                size={13.5}
                color={t.key === 'effect' ? c.ink3 : ACCENT.crit}
                accessibilityRole={t.key === 'effect' ? 'text' : 'alert'}
              >
                {t.text}
              </Body>
            ))}

            {needsDestinations
              ? lines.map((l) => (
                  <LineDestination
                    key={l.id}
                    line={l}
                    choice={choiceFor(l, choices)}
                    disabled={submitting}
                    reasonCode={wb.return.reasonCode}
                    showHint={mode === 'process'}
                    onChange={(next) => {
                      setChoices((prev) => ({ ...prev, [l.id]: next }));
                      setError(null);
                    }}
                  />
                ))
              : null}

            {mode === 'approve' ? (
              <>
                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Body size={14.5} color={c.ink}>
                      {RETURNS_COPY.itemIsHere}
                    </Body>
                    <Body size={12.5} muted>
                      {RETURNS_COPY.itemIsHereHelp}
                    </Body>
                  </View>
                  <Switch
                    value={itemIsHere}
                    onValueChange={setItemIsHere}
                    disabled={submitting}
                    accessibilityLabel={RETURNS_COPY.itemIsHere}
                    accessibilityHint={RETURNS_COPY.itemIsHereHelp}
                  />
                </View>
                <ExchangeReview
                  wb={wb}
                  reviews={reviews}
                  adds={adds}
                  online={online}
                  disabled={submitting}
                  loaderFor={loaderFor}
                  onReview={(id, next) => {
                    setReviews((prev) => ({ ...prev, [id]: next }));
                    setShortDetail(null);
                    setError(null);
                  }}
                  onAdd={(lineId, next) => {
                    setAdds((prev) => ({ ...prev, [lineId]: next }));
                    setShortDetail(null);
                    setError(null);
                  }}
                  onTop={(y) => {
                    reviewTop.current = y;
                  }}
                  onCardTop={(id, y) => {
                    reviewCardTop.current[id] = y;
                  }}
                  onHeading={(id, node) => {
                    reviewHeading.current[id] = node;
                  }}
                />
                {(() => {
                  const happens =
                    hasExchange || Object.values(adds).some(Boolean)
                      ? exchangeWhatHappens(wb, choices, reviews, adds, itemIsHere)
                      : whatHappensLines(wb, choices);
                  return (
                    <View style={{ gap: 4 }} accessible accessibilityLabel={happens.map((t) => t.text).join(' ')}>
                      <FieldLabel>WHAT HAPPENS WHEN YOU APPROVE</FieldLabel>
                      {happens.map((t) => (
                        <Body key={t.key} size={13.5} muted>
                          {t.text}
                        </Body>
                      ))}
                    </View>
                  );
                })()}
              </>
            ) : null}

            {mode === 'change_replacement' || mode === 'issue_replacement'
              ? changeLines.map((x) => {
                  const rl = wb.lines.find((l) => l.id === x.returnLineId);
                  const label = rl ? lineLabel(rl) : 'Item';
                  const pick = pickFor(x);
                  return (
                    <View key={x.id} style={[styles.lineCard, { borderColor: c.hair }]}>
                      <Body size={14.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                        {label}
                      </Body>
                      <ReplacementPickerList
                        load={loaderFor(rl?.orderRequestLineId ?? '')}
                        needed={pick.quantity}
                        selectedItemId={pick.itemId}
                        onSelect={(row, rowLabel) => {
                          setPicks((prev) => ({ ...prev, [x.id]: { ...pick, itemId: row.itemId, label: rowLabel } }));
                          setShortDetail(null);
                        }}
                        label={label}
                        online={online}
                        disabled={submitting}
                      />
                      {/* Review fix P12: how many, 1 to the returned quantity. */}
                      <ReplacementQuantityStepper
                        value={pick.quantity}
                        max={replacementQuantityMax(wb, x.returnLineId)}
                        label={label}
                        disabled={submitting}
                        onChange={(quantity) => {
                          setPicks((prev) => ({ ...prev, [x.id]: { ...pick, quantity } }));
                          setShortDetail(null);
                        }}
                      />
                    </View>
                  );
                })
              : null}

            {mode === 'release' ? (
              <View style={{ gap: 8 }}>
                <Body size={13.5} muted>
                  {RETURNS_COPY.releaseEarlyConfirm}
                </Body>
                {[RETURNS_COPY.releasePresetInPerson, RETURNS_COPY.releasePresetDeliverySwap].map((preset) => (
                  <Pressable
                    key={preset}
                    disabled={submitting}
                    onPress={() => setReason(preset)}
                    accessibilityRole="button"
                    accessibilityLabel={preset}
                    accessibilityState={{ selected: reason === preset }}
                    style={[styles.option, { borderColor: reason === preset ? c.ink : c.hair, minHeight: MIN_TAP }]}
                  >
                    <Body size={14} color={c.ink}>
                      {preset}
                    </Body>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {sitePrompt ? (
              <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={RETURNS_COPY.siteChoiceTitle}>
                <FieldLabel>{RETURNS_COPY.siteChoiceTitle}</FieldLabel>
                <Body size={13} color={c.ink3}>
                  {RETURNS_COPY.siteChoiceHelp}
                </Body>
                {siteOptions.map((o) => (
                  <Pressable
                    key={o.key}
                    onPress={() => setSiteKey(o.key)}
                    accessibilityRole="radio"
                    accessibilityLabel={o.label}
                    accessibilityState={{ checked: siteKey === o.key }}
                    style={[styles.option, { borderColor: siteKey === o.key ? c.ink : c.hair, minHeight: MIN_TAP }]}
                  >
                    <Body size={14} color={c.ink}>
                      {o.label}
                    </Body>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {mode === 'close_as_return_only' ? (
              <Body size={13.5} color={c.ink3}>
                {RETURNS_COPY.closeAsReturnOnlyHelp}
              </Body>
            ) : null}
            {shortLines.length > 0 ? (
              <View style={{ gap: 6 }}>
                <View style={{ gap: 6 }} accessibilityRole="alert">
                  {shortLines.map((t) => (
                    <Body key={t} size={13.5} color={ACCENT.crit}>
                      {t}
                    </Body>
                  ))}
                </View>
                <Button variant="outline" disabled={!canSubmit} onPress={() => void submit('backorder')}>
                  {shortBackorderLabel(mode)}
                </Button>
                {/* Review fix P7: or change the short lines' replacement (a
                    local switch: the picker asks the server, which says when
                    it needs a connection). */}
                {mode === 'approve' && wb.viewer.canApproveOrders ? (
                  <Button variant="outline" disabled={submitting} onPress={changeShortLines}>
                    {RETURNS_COPY.changeReplacement}
                  </Button>
                ) : null}
              </View>
            ) : null}

            {mode === 'deny' || mode === 'cancel' || reasonRequired ? (
              <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
                <FieldLabel>{reasonFieldLabel(mode, ex.hasApprovedExchange).toUpperCase()}</FieldLabel>
                {mode === 'deny' ? (
                  <Body size={13} muted>
                    {denyHelp(wb)}
                  </Body>
                ) : null}
                <TextInput
                  value={reason}
                  onChangeText={(t) => {
                    setReason(t);
                    setError(null);
                  }}
                  onFocus={kb.onNoteFocus}
                  onBlur={kb.onNoteBlur}
                  onLayout={kb.onNoteLayout}
                  maxFontSizeMultiplier={NOTE_FONT_CAP}
                  multiline
                  editable={!submitting}
                  placeholder={
                    mode === 'deny'
                      ? 'Why the return is denied'
                      : mode === 'cancel'
                        ? reasonRequired
                          ? 'Why the return is cancelled'
                          : 'Why the return is cancelled (optional)'
                        : 'Why'
                  }
                  placeholderTextColor={c.ink4}
                  accessibilityLabel={reasonFieldLabel(mode, ex.hasApprovedExchange)}
                  style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
                />
                <Mono size={11} color={reasonCount > reasonMax ? ACCENT.crit : c.ink4}>
                  {`${reasonCount.toLocaleString('en-US')} / ${reasonMax.toLocaleString('en-US')}`}
                </Mono>
              </View>
            ) : null}
          </ScrollView>

          {disabledReason ? (
            <Body size={13} color={c.ink3} accessibilityRole="text">
              {disabledReason}
            </Body>
          ) : null}
          {error ? (
            <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}

          <Button
            block
            variant={mode === 'deny' || mode === 'cancel' || mode === 'cancel_replacement' ? 'destructive' : 'primary'}
            disabled={!canSubmit}
            accessibilityHint={disabledReason ?? undefined}
            onPress={() => void submit()}
          >
            {submitting ? 'Saving…' : cta}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** The reason field's label for each mode that asks one. */
function reasonFieldLabel(mode: ReturnSheetMode, hasApprovedExchange: boolean): string {
  switch (mode) {
    case 'deny':
      return RETURNS_COPY.denyReasonLabel;
    case 'cancel':
      return hasApprovedExchange ? RETURNS_COPY.cancelReturnReasonRequired : RETURNS_COPY.cancelReasonLabel;
    case 'release':
      return RETURNS_COPY.releaseEarlyReasonLabel;
    case 'cancel_replacement':
      return RETURNS_COPY.cancelReplacementReasonLabel;
    case 'close_as_return_only':
      return RETURNS_COPY.closeAsReturnOnlyReasonLabel;
    default:
      return RETURNS_COPY.replacementReasonLabel;
  }
}

/**
 * RX-2: the approval's exchange review. Per requested exchange line: Approve
 * as requested, Change replacement… (the picker and a reason when it differs
 * from the request) or Decline the exchange, return only (a reason). A
 * return-only line can get "Add a replacement" while exchanges are on.
 *
 * Review fix P1: shown to every returns manager. The rows are core's
 * (exchangeReviewOptions): without order approval "Approve as requested" and
 * "Change replacement" are off, each label ending with why, and the review
 * starts at the decline (exchangeReviewStateFor). "Add a replacement" needs
 * order approval, so it is not offered without it. Nothing is drawn when no
 * line has anything to review.
 */
function ExchangeReview({
  wb,
  reviews,
  adds,
  online,
  disabled,
  loaderFor,
  onReview,
  onAdd,
  onTop,
  onCardTop,
  onHeading,
}: {
  wb: MobileReturnWorkbench;
  reviews: Record<string, ExchangeReviewState>;
  adds: Record<string, AddState>;
  online: boolean;
  disabled: boolean;
  loaderFor: (orderRequestLineId: string) => (q: string) => ReturnType<typeof getReturnCandidates>;
  onReview: (exchangeLineId: string, next: ExchangeReviewState) => void;
  onAdd: (returnLineId: string, next: AddState) => void;
  /** Review fix P7: where the review, and each card in it, sits (the sheet
   *  scrolls to a short line), and each card's heading (VoiceOver goes there). */
  onTop: (y: number) => void;
  onCardTop: (id: string, y: number) => void;
  onHeading: (id: string, node: View | null) => void;
}) {
  const { c } = useTheme();
  const ex = exchangeOf(wb);
  const thumb = (uri: string | null) =>
    uri ? (
      <Image source={{ uri }} style={[styles.thumb, { backgroundColor: c.paper2 }]} accessibilityIgnoresInvertColors />
    ) : (
      <View style={[styles.thumb, { backgroundColor: c.paper2 }]} />
    );
  const rows = wb.lines.map((l) => {
    const x = ex.lines.find((e) => e.returnLineId === l.id) ?? null;
    const label = lineLabel(l);
    if (!x) {
      if (!ex.createEnabled || l.applied || !wb.viewer.canApproveOrders) return null;
      const add = adds[l.id] ?? null;
      return (
        <View key={l.id} onLayout={(e) => onCardTop(l.id, e.nativeEvent.layout.y)} style={[styles.lineCard, { borderColor: c.hair }]}>
          <View ref={(node) => onHeading(l.id, node)} accessible>
            <Body size={14} color={c.ink}>
              {label}
            </Body>
          </View>
          {add ? (
            <>
              <ReplacementPickerList
                load={loaderFor(l.orderRequestLineId)}
                needed={add.quantity}
                selectedItemId={add.itemId}
                onSelect={(row, rowLabel) => onAdd(l.id, { ...add, itemId: row.itemId, label: rowLabel, free: row.free })}
                label={label}
                online={online}
                disabled={disabled}
              />
              <ReplacementQuantityStepper
                value={add.quantity}
                max={replacementQuantityMax(wb, l.id)}
                label={label}
                disabled={disabled}
                onChange={(quantity) => onAdd(l.id, { ...add, quantity })}
              />
              {/* Review fix P27: the undo reads as the action it is. */}
              <Button size="sm" variant="outline" disabled={disabled} onPress={() => onAdd(l.id, null)}>
                {RETURNS_COPY.keepAsReturnOnly}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !online}
              onPress={() => onAdd(l.id, { itemId: null, label: null, quantity: l.quantity, free: null })}
            >
              {RETURNS_COPY.addReplacement}
            </Button>
          )}
        </View>
      );
    }
    if (x.status !== 'requested') return null;
    const v = exchangeReviewStateFor(wb, reviews, x.id);
    const requested = x.requestedItem
      ? returnLineLabel(x.requestedItem.name, x.requestedItem.variant)
      : RETURNS_COPY.replacementWarehouseReview;
    return (
      <View key={x.id} onLayout={(e) => onCardTop(x.id, e.nativeEvent.layout.y)} style={[styles.lineCard, { borderColor: c.hair }]}>
        {/* Review fix P26: VoiceOver reads the heading in words, never the
            arrow ("right arrow"). */}
        <View
          ref={(node) => onHeading(x.id, node)}
          accessible
          accessibilityLabel={exchangeReviewHeaderLabel(label, x.requestedItem ? requested : null)}
        >
          {/* Review fix P11: a small photo of each side (inside the one
              accessible heading, so VoiceOver reads its words only). */}
          {itemPhotoUrl(l.item) || itemPhotoUrl(x.requestedItem) ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              {thumb(itemPhotoUrl(l.item))}
              <Body size={14} color={c.ink3}>
                →
              </Body>
              {thumb(itemPhotoUrl(x.requestedItem))}
            </View>
          ) : null}
          <Body size={14} color={c.ink}>
            {label} → {requested}
          </Body>
        </View>
        {x.requestNote ? (
          <Body size={12.5} muted>
            {RETURNS_COPY.replacementNoteFromRequester}: {x.requestNote}
          </Body>
        ) : null}
        <View accessibilityRole="radiogroup" accessibilityLabel={`Decision for the replacement of ${label}`} style={{ gap: 6 }}>
          {exchangeReviewOptions(x, wb.viewer).map((option) => {
            const kind = option.kind;
            const checked = v.kind === kind;
            // An off choice says why in its label, so VoiceOver reads the
            // reason with hints off (core's "…. Needs order approval
            // permission.").
            const off = disabled || option.disabled;
            return (
              <Pressable
                key={kind}
                disabled={off}
                onPress={() =>
                  onReview(
                    x.id,
                    kind === 'as_requested'
                      ? { kind }
                      : kind === 'decline'
                        ? { kind, reason: '' }
                        : { kind, itemId: null, label: null, free: null, quantity: Math.min(x.requestedQuantity, l.quantity), reason: '' },
                  )
                }
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked, disabled: off }}
                style={[
                  styles.option,
                  {
                    borderColor: checked ? c.ink : c.hair,
                    backgroundColor: checked ? c.paper2 : 'transparent',
                    opacity: option.disabled ? 0.6 : 1,
                    minHeight: MIN_TAP,
                  },
                ]}
              >
                <Body size={14} color={c.ink}>
                  {option.label}
                </Body>
              </Pressable>
            );
          })}
        </View>
        {v.kind === 'change' ? (
          <>
            <ReplacementPickerList
              load={loaderFor(l.orderRequestLineId)}
              needed={v.quantity}
              selectedItemId={v.itemId}
              onSelect={(row, rowLabel) => onReview(x.id, { ...v, itemId: row.itemId, label: rowLabel, free: row.free })}
              label={label}
              online={online}
              disabled={disabled}
            />
            {/* Review fix P12: how many, 1 to the returned quantity. */}
            <ReplacementQuantityStepper
              value={v.quantity}
              max={replacementQuantityMax(wb, l.id)}
              label={label}
              disabled={disabled}
              onChange={(quantity) => onReview(x.id, { ...v, quantity })}
            />
          </>
        ) : null}
        {v.kind === 'change' || v.kind === 'decline' ? (
          <TextInput
            value={v.reason}
            onChangeText={(t) => onReview(x.id, { ...v, reason: t })}
            editable={!disabled}
            multiline
            maxFontSizeMultiplier={NOTE_FONT_CAP}
            placeholder={v.kind === 'decline' ? RETURNS_COPY.declineReasonLabel : RETURNS_COPY.replacementReasonLabel}
            placeholderTextColor={c.ink4}
            accessibilityLabel={v.kind === 'decline' ? RETURNS_COPY.declineReasonLabel : RETURNS_COPY.replacementReasonLabel}
            accessibilityHint={RETURNS_COPY.replacementReasonHelp}
            style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink, minHeight: 64 }]}
          />
        ) : null}
      </View>
    );
  });
  if (!rows.some(Boolean)) return null;
  return (
    <View style={{ gap: 10 }} onLayout={(e) => onTop(e.nativeEvent.layout.y)}>
      <FieldLabel>{RETURNS_COPY.replacement}</FieldLabel>
      {rows}
    </View>
  );
}

/** One returned line's disposition and destination, as radio groups. */
function LineDestination({
  line,
  choice,
  disabled,
  reasonCode,
  showHint,
  onChange,
}: {
  line: MobileReturnWorkbenchLine;
  choice: RestockChoice;
  disabled: boolean;
  reasonCode: string | null;
  showHint: boolean;
  onChange: (next: RestockChoice) => void;
}) {
  const { c } = useTheme();
  const name = line.item.name ?? 'Item';
  const rows = line.restock ? restockOptionRows(line.restock) : [];
  const selectedKey = choiceKey(choice);
  const hint = damagedHint(reasonCode);
  // Back from scrap: the original rack only when it is offered to this viewer.
  const restockKey = (): string =>
    line.restock?.preselect === 'original' && isChoiceOffered(line.restock, { disposition: 'restock', target: 'original', locationId: null })
      ? 'original'
      : 'staging';

  return (
    <View style={[styles.lineCard, { borderColor: c.hair }]}>
      <Body size={14.5} color={c.ink} style={{ fontFamily: FONT.display }}>
        {name}
        {line.item.variant ? ` · ${line.item.variant}` : ''}
      </Body>
      <Body size={12.5} muted>
        {qtyReturningLabel(line.quantity)}
      </Body>

      <FieldLabel>{RETURNS_COPY.returnDisposition}</FieldLabel>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.returnDisposition} for ${name}`} style={styles.radioRow}>
        {(['restock', 'scrap'] as const).map((d) => {
          const checked = choice.disposition === d;
          return (
            <Pressable
              key={d}
              disabled={disabled}
              onPress={() => onChange(choiceFromKey(d, d === 'restock' ? (selectedKey ?? restockKey()) : null))}
              accessibilityRole="radio"
              accessibilityLabel={d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
              accessibilityState={{ checked, disabled }}
              style={[styles.chip, { borderColor: checked ? c.ink : c.hair, backgroundColor: checked ? c.paper2 : 'transparent' }]}
            >
              <Body size={14} color={c.ink}>
                {d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
              </Body>
            </Pressable>
          );
        })}
      </View>
      {hint ? (
        <Body size={12.5} muted>
          {hint}
        </Body>
      ) : null}

      {choice.disposition === 'restock' ? (
        <>
          <FieldLabel>{RETURNS_COPY.returnedItemDestination}</FieldLabel>
          <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.returnedItemDestination} for ${name}`} style={{ gap: 8 }}>
            {rows.map((row) => {
              const checked = selectedKey === row.key;
              const off = disabled || !row.enabled;
              const why = !row.enabled && row.disabledReason && row.disabledReason !== row.label ? row.disabledReason : null;
              return (
                <Pressable
                  key={row.key}
                  disabled={off}
                  onPress={() => onChange(choiceFromKey('restock', row.key))}
                  accessibilityRole="radio"
                  // The reason a row cannot be chosen is part of its label, so
                  // VoiceOver reads it with hints off (returns review).
                  accessibilityLabel={why ? `${row.label}. ${why}` : row.label}
                  accessibilityHint={row.enabled ? (row.help ?? undefined) : undefined}
                  accessibilityState={{ checked, disabled: off }}
                  style={[
                    styles.option,
                    { borderColor: checked ? c.ink : c.hair, backgroundColor: checked ? c.paper2 : 'transparent', opacity: row.enabled ? 1 : 0.6, minHeight: MIN_TAP },
                  ]}
                >
                  <Body size={14} color={c.ink}>
                    {row.label}
                  </Body>
                  {row.help && row.enabled ? (
                    <Body size={12.5} muted>
                      {row.help}
                    </Body>
                  ) : null}
                  {!row.enabled && row.disabledReason && row.disabledReason !== row.label ? (
                    <Body size={12.5} muted>
                      {row.disabledReason}
                    </Body>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {showHint ? (
        <Body size={12.5} muted>
          {processingHint(line, choice)}
        </Body>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 32, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { minHeight: 96, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  radioRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, minHeight: MIN_TAP, justifyContent: 'center' },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', gap: 2 },
  thumb: { width: 40, height: 40, borderRadius: 8 },
});
