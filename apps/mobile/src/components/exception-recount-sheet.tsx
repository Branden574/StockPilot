import { X } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  RECOUNT_COUNTS_TOTAL_COPY,
  RECOUNT_MANAGER_ONLY_COPY,
  recountDisabledReason,
  recountResultSummary,
  type RecountResultSummary,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  describeRecountError,
  listExceptions,
  recountKeyFor,
  startRecount,
} from '@/lib/exceptions-api';
import { buildReassignCandidates, loadOrgMembers, type ReassignCandidate } from '@/lib/org-members';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
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
 */
export function ExceptionRecountSheet(props: {
  visible: boolean;
  title: string;
  /** The exceptions to recount (the list's selection, or one exception). */
  occurrenceIds?: readonly string[];
  /** "Count this item": this item, plus its recountable open exceptions. */
  itemId?: string | null;
  orgId: string | null;
  online: boolean;
  timeZone?: string | null;
  onClose: () => void;
  /** A recount was started or linked and the result was dismissed. */
  onDone: () => void;
  onOpenCount: (cycleCountId: string) => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      {/* Remounted per opening (key): every opening starts with no earlier
          attempt, key or result. */}
      {props.visible ? <SheetContent key="open" {...props} /> : null}
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
  | { kind: 'ready'; occurrenceIds: string[]; canRecount: boolean }
  | { kind: 'failed' };

function SheetContent({
  title,
  occurrenceIds: givenOccurrenceIds = [],
  itemId = null,
  orgId,
  online,
  timeZone,
  onClose,
  onDone,
  onOpenCount,
}: {
  title: string;
  occurrenceIds?: readonly string[];
  itemId?: string | null;
  orgId: string | null;
  online: boolean;
  timeZone?: string | null;
  onClose: () => void;
  onDone: () => void;
  onOpenCount: (cycleCountId: string) => void;
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
  const itemIds = itemId ? [itemId] : [];
  const blocked = targets.kind === 'ready' && !targets.canRecount ? RECOUNT_MANAGER_ONLY_COPY : null;
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
    } catch (e) {
      const described = describeRecountError(e);
      // The key stands for another selection: never send it again.
      if (described.dropKey) keyRef.current = null;
      setError({ message: described.message, retryable: described.retryable });
    } finally {
      setSubmitting(false);
    }
  }

  const note =
    targets.kind === 'failed'
      ? 'This item’s open exceptions could not be read, so the count will not be linked to them. The system still checks them after the count is posted.'
      : targets.kind === 'ready' && targets.occurrenceIds.length > 0
        ? `The count will be linked to this item’s ${targets.occurrenceIds.length === 1 ? 'open exception' : `${targets.occurrenceIds.length} open exceptions`}.`
        : null;

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      {/* Backdrop is a SIBLING behind the sheet, not its parent, so the body
          scrolls (see add-order-items-sheet.tsx). */}
      <Pressable
        onPress={submitting ? undefined : onClose}
        accessibilityLabel="Close"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
        ]}
      />
      <View style={[styles.sheet, { backgroundColor: c.card }]}>
        <View style={styles.header}>
          <Body size={16} color={c.ink} style={{ fontFamily: FONT.display, flex: 1 }}>
            {summary ? 'Recount' : title}
          </Body>
          <Pressable
            onPress={summary ? onDone : onClose}
            disabled={submitting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={18} color={c.ink4} />
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
                  style={{ alignSelf: 'flex-start' }}
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
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
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
                A recount is an ordinary count. It changes no stock until a manager posts it, and the system then
                checks these exceptions again.
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
                    <ActivityIndicator color={c.ink4} style={{ alignSelf: 'flex-start', marginVertical: 8 }} />
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
                          style={{ alignSelf: 'flex-start' }}
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
              <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
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
        borderColor: selected ? c.ink : c.hair,
        backgroundColor: selected ? c.paper2 : 'transparent',
        justifyContent: 'center',
      }}
    >
      <Body size={15} color={c.ink} style={{ fontFamily: selected ? FONT.display : undefined }}>
        {name}
      </Body>
      {detail ? (
        <Mono size={11} color={c.ink4}>
          {detail}
        </Mono>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 32,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
