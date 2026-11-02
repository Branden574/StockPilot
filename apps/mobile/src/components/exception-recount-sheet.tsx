import { Circle, CircleDot, X } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  RECOUNT_COUNTS_TOTAL_COPY,
  recountDisabledReason,
  recountResultSummary,
  recountUnavailableCopy,
  type RecountResultSummary,
  type RecountUnavailableReason,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  describeRecountError,
  listExceptions,
  recountKeyFor,
  startRecount,
} from '@/lib/exceptions-api';
import { buildReassignCandidates, loadOrgMembers, type ReassignCandidate } from '@/lib/org-members';
import { supabase } from '@/lib/supabase';
import { FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * THE RECOUNT SHEET (F1-2): the phone's twin of the web RecountDialog, for
 * the Exceptions list ("Recount selected"), one exception, and the item
 * screen ("Count this item").
 *
 *   - It says what a count covers (core RECOUNT_COUNTS_TOTAL_COPY) and offers
 *     "Assign to" from the reassign sheet's member source (loadOrgMembers +
 *     buildReassignCandidates, accepted members), with Unassigned first. A
 *     failed member read says so and still allows an unassigned start.
 *   - ONLINE ONLY. The recount is created by the server in one transaction;
 *     there is no offline queue for it. Offline, Start is disabled with the
 *     reason (core recountDisabledReason, fed the LIVE network state).
 *   - ONE COUNT PER SELECTION: the idempotency key belongs to the selection
 *     (recountKeyFor) and is resent on every retry of it, so a lost answer or
 *     a retryable refusal never starts a second count. A key the server says
 *     stands for another selection is dropped.
 *   - Then the result, worded by core recountResultSummary (the web says the
 *     same): Started CC-..., Already being counted in CC-..., linked, and
 *     Skipped.
 *
 * For "Count this item" (`itemId`), it first reads the item's open exceptions
 * a recount can settle and names them, so the count is linked to them; if
 * that read fails the item can still be counted, and the sheet says the count
 * will not be linked.
 *
 * For "Recount items here" (`itemIds`, F1-3, the location screen), it counts
 * the items it is given, at most RECOUNT_MAX_ITEMS (the server refuses more),
 * and says how many. Nothing is linked up front; the system checks the
 * exceptions again after the count is posted.
 */
export function ExceptionRecountSheet(props: {
  visible: boolean;
  title: string;
  /** The exceptions to recount (the list's selection, or one exception). */
  occurrenceIds?: readonly string[];
  /** "Count this item": this item, plus its recountable open exceptions. */
  itemId?: string | null;
  /** "Recount items here": these items (the location screen gathers them). */
  itemIds?: readonly string[];
  orgId: string | null;
  online: boolean;
  timeZone?: string | null;
  onClose: () => void;
  /** A recount was started or linked and the result was dismissed. */
  onDone: () => void;
  onOpenCount: (cycleCountId: string) => void;
}) {
  // Whether this opening of the sheet shows its result. Once it does, every
  // way out is Done, so the caller re-reads and clears its selection; that
  // includes Android's back button, which closes through the Modal. A new
  // opening starts without a result (React's "adjust state when a prop
  // changes" pattern, no effect).
  const [resultShown, setResultShown] = React.useState(false);
  const [wasVisible, setWasVisible] = React.useState(props.visible);
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible);
    setResultShown(false);
  }
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={resultShown ? props.onDone : props.onClose}
    >
      {/* Remounted per opening (key): every opening starts with no earlier
          attempt, key or result. */}
      {props.visible ? (
        <SheetContent key="open" {...props} onResultShown={() => setResultShown(true)} />
      ) : null}
    </Modal>
  );
}

type Members =
  | { kind: 'loading' }
  | { kind: 'ready'; list: ReassignCandidate[] }
  | { kind: 'failed' };

type Targets =
  | { kind: 'none' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      occurrenceIds: string[];
      canRecount: boolean;
      unavailableReason: RecountUnavailableReason | null;
    }
  | { kind: 'failed' };

function SheetContent({
  title,
  occurrenceIds: givenOccurrenceIds = [],
  itemId = null,
  itemIds: givenItemIds = [],
  orgId,
  online,
  timeZone,
  onClose,
  onDone,
  onOpenCount,
  onResultShown,
}: {
  title: string;
  occurrenceIds?: readonly string[];
  itemId?: string | null;
  itemIds?: readonly string[];
  orgId: string | null;
  online: boolean;
  timeZone?: string | null;
  onClose: () => void;
  onDone: () => void;
  onOpenCount: (cycleCountId: string) => void;
  /** The result is on screen: the Modal's own way out becomes Done too. */
  onResultShown: () => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [members, setMembers] = React.useState<Members>(orgId ? { kind: 'loading' } : { kind: 'failed' });
  const [membersNonce, setMembersNonce] = React.useState(0);
  const [assignee, setAssignee] = React.useState<string | null>(null);
  const [targets, setTargets] = React.useState<Targets>(itemId ? { kind: 'loading' } : { kind: 'none' });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; retryable: boolean } | null>(null);
  const [summary, setSummary] = React.useState<RecountResultSummary | null>(null);
  // The key for THIS selection, reused on every send of it. Read only in the
  // submit handler.
  const keyRef = React.useRef<{ signature: string; key: string } | null>(null);

  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { members: rows, profiles } = await loadOrgMembers<{
          id: string;
          full_name: string | null;
          email: string | null;
        }>(supabase, orgId, { acceptedOnly: true, profileColumns: 'id, full_name, email' });
        if (!cancelled) setMembers({ kind: 'ready', list: buildReassignCandidates(rows, profiles) });
      } catch (e) {
        console.warn('[recount] members load failed:', e instanceof Error ? e.message : e);
        if (!cancelled) setMembers({ kind: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, membersNonce]);

  React.useEffect(() => {
    if (!itemId || !online) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listExceptions('open', { itemId });
        if (cancelled) return;
        setTargets({
          kind: 'ready',
          canRecount: list.canRecount,
          unavailableReason: list.recountUnavailableReason,
          occurrenceIds: list.occurrences.filter((o) => o.canRecount).map((o) => o.id),
        });
      } catch {
        if (!cancelled) setTargets({ kind: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, online]);

  const occurrenceIds =
    targets.kind === 'ready' ? targets.occurrenceIds : targets.kind === 'none' ? [...givenOccurrenceIds] : [];
  const itemIds = itemId ? [itemId] : [...givenItemIds];
  // "Recount items here": a list of items and no exceptions.
  const itemList = !itemId && givenItemIds.length > 0 && givenOccurrenceIds.length === 0;
  const blocked =
    targets.kind === 'ready' && !targets.canRecount ? recountUnavailableCopy(targets.unavailableReason) : null;
  // Offline first among the reasons that can change: reconnecting enables it.
  const disabledReason = blocked ?? recountDisabledReason({ canRecount: true, online });
  const preparing = targets.kind === 'loading' && online;
  const canSubmit =
    !submitting && !preparing && disabledReason === null && (occurrenceIds.length > 0 || itemIds.length > 0);

  async function submit() {
    if (!canSubmit) return;
    keyRef.current = recountKeyFor(keyRef.current, occurrenceIds, itemIds);
    const idempotencyKey = keyRef.current.key;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startRecount({ occurrenceIds, itemIds, assignedTo: assignee, idempotencyKey });
      const assigneeLabel =
        result.assignedTo && members.kind === 'ready'
          ? (members.list.find((m) => m.userId === result.assignedTo)?.name ?? null)
          : null;
      setSummary(recountResultSummary(result, { timeZone, assigneeLabel }));
      onResultShown();
    } catch (e) {
      const described = describeRecountError(e);
      // The key stands for another selection: never send it again.
      if (described.dropKey) keyRef.current = null;
      setError({ message: described.message, retryable: described.retryable });
    } finally {
      setSubmitting(false);
    }
  }

  // Every way out of the sheet once the result shows is Done (the caller
  // re-reads and clears its selection). Only the X used to take Done there;
  // the scrim (and the Modal's own close) took onClose, so a recount started
  // and then dismissed by a tap outside left the list, the card or the
  // location as they were before it, and the exceptions list kept its
  // selection.
  const dismiss = summary ? onDone : onClose;

  const note =
    targets.kind === 'failed'
      ? 'This item’s open exceptions could not be read, so the count will not be linked to them. The system still checks them after the count is posted.'
      : targets.kind === 'ready' && targets.occurrenceIds.length > 0
        ? `The count will be linked to this item’s ${targets.occurrenceIds.length === 1 ? 'open exception' : `${targets.occurrenceIds.length} open exceptions`}.`
        : itemList
          ? `The recount will include ${itemIds.length === 1 ? '1 item' : `${itemIds.length} items`}.`
          : null;

  return (
    // VoiceOver stays inside the open sheet (accessibilityViewIsModal) and the
    // escape scrub closes it as the scrim does; the scrim is a "Close" button
    // a double tap closes (onAccessibilityTap), the app's sheet rule
    // (sheet-a11y-structure.test.ts has the why). It had the name only.
    <View
      style={{ flex: 1, justifyContent: 'flex-end' }}
      accessibilityViewIsModal
      onAccessibilityEscape={submitting ? undefined : dismiss}
    >
      {/* Backdrop is a SIBLING behind the sheet, not its parent, so the body
          scrolls (see add-order-items-sheet.tsx). */}
      <Pressable
        onPress={submitting ? undefined : dismiss}
        onAccessibilityTap={submitting ? undefined : dismiss}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
        ]}
      />
      <View style={[styles.sheet, { backgroundColor: c.card }, SHADOW.sheet]}>
        <View style={styles.header}>
          <Body size={16} color={c.ink} style={{ fontFamily: FONT.display, flex: 1 }}>
            {summary ? 'Recount' : title}
          </Body>
          {/* A 44pt frame around the same 18pt X, its margins giving the
              space back (it was the X with hitSlop), in the muted ink. */}
          <Pressable
            onPress={dismiss}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={({ pressed }) => [styles.close, { opacity: pressed ? 0.7 : 1 }]}
          >
            <X size={18} color={c.ink3} />
          </Pressable>
        </View>

        {summary ? (
          <ScrollView contentContainerStyle={{ gap: 12 }} style={{ maxHeight: 440 }}>
            {summary.started ? (
              <View style={{ gap: 6 }}>
                <Body size={15} color={c.ink}>
                  {summary.started.text}
                </Body>
                {summary.assignment ? (
                  <Body size={14} muted>
                    {summary.assignment}
                  </Body>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => onOpenCount(summary.started!.cycleCountId)}
                  // 44pt, not the small Button's 36.
                  style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}
                >
                  Open the count
                </Button>
              </View>
            ) : null}
            {summary.alreadyCounting.map((a) => (
              <Pressable
                key={a.cycleCountId}
                onPress={() => onOpenCount(a.cycleCountId)}
                accessibilityRole="link"
                // A frame at least 44pt tall around the sentence.
                style={({ pressed }) => ({
                  minHeight: MIN_TAP,
                  justifyContent: 'center',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Body size={14} color={c.ink}>
                  {a.text}
                </Body>
              </Pressable>
            ))}
            {summary.skipped.map((s) => (
              <Body key={s} size={14} muted>
                {s}
              </Body>
            ))}
            {summary.nothing ? (
              <Body size={14} muted>
                {summary.nothing}
              </Body>
            ) : null}
            <Button block onPress={onDone}>
              Done
            </Button>
          </ScrollView>
        ) : (
          <>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }} style={{ maxHeight: 440 }}>
              <Body size={14}>{RECOUNT_COUNTS_TOTAL_COPY}</Body>
              <Body size={13.5} muted>
                {itemList
                  ? 'A recount is an ordinary count. It changes no stock until a manager posts it, and the system then checks these items’ exceptions again.'
                  : 'A recount is an ordinary count. It changes no stock until a manager posts it, and the system then checks these exceptions again.'}
              </Body>
              {preparing ? (
                <Body size={13.5} muted accessibilityRole="text">
                  Checking this item’s open exceptions...
                </Body>
              ) : null}
              {note ? (
                <Body size={13.5} muted>
                  {note}
                </Body>
              ) : null}

              {blocked ? null : (
                <View style={{ gap: 6 }}>
                  <FieldLabel>ASSIGN TO (OPTIONAL)</FieldLabel>
                  {members.kind === 'loading' ? (
                    <ActivityIndicator
                      color={c.ink3}
                      style={{ alignSelf: 'flex-start', marginVertical: 8 }}
                    />
                  ) : members.kind === 'failed' ? (
                    <View style={{ gap: 8 }}>
                      <Body size={13.5} muted>
                        Team members could not be loaded. You can start the recount unassigned and assign it from
                        the count.
                      </Body>
                      {orgId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          // 44pt, not the small Button's 36.
                          style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}
                          onPress={() => {
                            setMembers({ kind: 'loading' });
                            setMembersNonce((n) => n + 1);
                          }}
                        >
                          Try again
                        </Button>
                      ) : null}
                    </View>
                  ) : (
                    <View style={{ gap: 6 }}>
                      <MemberOption
                        name="Unassigned"
                        detail={null}
                        selected={assignee === null}
                        onPress={() => setAssignee(null)}
                      />
                      {members.list.map((m) => (
                        <MemberOption
                          key={m.userId}
                          name={m.name}
                          detail={m.role}
                          selected={assignee === m.userId}
                          onPress={() => setAssignee(m.userId)}
                        />
                      ))}
                      <Body size={12.5} muted>
                        The assignee gets a notification to start the count.
                      </Body>
                    </View>
                  )}
                </View>
              )}
            </ScrollView>

            {/* Disabled-with-reason: a greyed-out button with no explanation
                reads as a broken app. */}
            {disabledReason ? (
              <Body size={13} color={c.ink3}>
                {disabledReason}
              </Body>
            ) : null}
            {error ? (
              <Body size={13} color={c.critText} accessibilityRole="alert">
                {error.message}
              </Body>
            ) : null}

            {blocked ? null : (
              <Button block disabled={!canSubmit} onPress={() => void submit()}>
                {submitting ? 'Starting...' : error?.retryable ? 'Try again' : 'Start recount'}
              </Button>
            )}
          </>
        )}
      </View>
    </View>
  );
}

function MemberOption({
  name,
  detail,
  selected,
  onPress,
}: {
  name: string;
  detail: string | null;
  selected: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  // The chosen member: the ink border, the recessed fill (paper2 is the card
  // colour in dark, so the fill did not show there) and a filled radio mark,
  // so the choice never rests on a colour alone; the role is in the muted ink.
  const Mark = selected ? CircleDot : Circle;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        minHeight: 48,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: selected ? c.ink : c.hair2,
        backgroundColor: selected ? c.sunk : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Mark size={20} color={selected ? c.ink : c.ink3} strokeWidth={1.8} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={15} color={c.ink} style={{ fontFamily: selected ? FONT.display : undefined }}>
          {name}
        </Body>
        {detail ? (
          <Mono size={11} color={c.ink3}>
            {detail}
          </Mono>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The app's bottom-sheet corners (the item screen's sheets), and its shadow.
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 18,
    paddingBottom: 32,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  // (44 - 18) / 2: above, below and to the right the frame takes up the X's
  // 18pt, as before, so the header row and the X stay where they were; to the
  // left it keeps the row's gap from the title.
  close: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    marginVertical: -13,
    marginRight: -13,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
