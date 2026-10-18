import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, BookMarked, Circle, CircleDot } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  GROUP_NAME_MAX_LENGTH,
  choicesForReview,
  groupBodyForPlan,
  groupingDecisionsFor,
  normalizeGroupName,
  planGrouping,
  suggestGroupName,
  type GroupDialogTarget,
  type GroupRecordChoice,
  type GroupingOutcome,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useAuth } from '@/lib/auth-context';
import {
  describeGroupingError,
  keyedGroupingBody,
  notifyDisplayGroupsChanged,
  postGrouping,
  previewGrouping,
  readGroupSelectedParams,
  reviewAnnouncement,
  reviewIdsForRetry,
  reviewRecordDetail,
  type GroupingIdentity,
  type PendingGroupingBody,
  type PhoneGroupingReview,
  type ReviewLoadState,
} from '@/lib/display-groups';
import { footerReservation } from '@/lib/dynamic-type-layout';
import { isOnline } from '@/lib/sync';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { countSelection } from '@/lib/use-count-selection';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * Group selected on the phone (migration 0400): the review before anything is
 * written, the twin of the web's GroupSelectedDialog over the same service.
 *
 * It says the brief's sentence first: grouping organizes records together; it
 * does not combine stock, change ownership, or move items. Then every selected
 * record the member can read (the rest as a count): its picture, name, SKU (a
 * book's ISBN, its edition), size, charter, rack and on hand; whether it is in
 * another group (never moved silently: per record, "Move it into this group"
 * or "Leave it out", which sends nothing for it; each choice is kept with the
 * group the record was in when it was made, and a new review that finds the
 * record in another group drops it, recheck R2-1); a product family it belongs
 * to (confirmed, never changed); records sharing a SKU that are not selected
 * and stay outside the group (never the group's own records); how the list
 * will show the group afterwards, and, when adding to a group that exists,
 * its other records (people review P1, P6, P8, P10).
 *
 * ONLINE ONLY and never queued. Cancel writes nothing. Save sends one key per
 * body and keeps it for a retry of that body (busy, a lost answer), so the
 * database replays the first outcome instead of making a second group; a
 * repeat after it applied answers that the records are already there.
 */
/** How many of an existing group's other records the review lists by name
 *  (the header above counts them all), as on the web. */
const TARGET_MEMBERS_SHOWN = 20;

/** Says a message to VoiceOver or TalkBack now. iOS ignores
 *  accessibilityLiveRegion, so the review announces what changed itself
 *  (people review P11). */
function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

export default function GroupSelectedScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const {
    ids: idsParam,
    view: viewParam,
    groupId: groupParam,
  } = useLocalSearchParams<{ ids?: string; view?: string; groupId?: string }>();
  const params = React.useMemo(
    () => readGroupSelectedParams({ ids: idsParam, view: viewParam, groupId: groupParam }),
    [idsParam, viewParam, groupParam],
  );
  const view = params?.view ?? 'items';

  // The records under review: the selection, plus same-SKU records the person
  // chose to add here.
  const [itemIds, setItemIds] = React.useState<string[]>(params?.itemIds ?? []);
  const [mode, setMode] = React.useState<'new' | 'existing'>(params?.groupId ? 'existing' : 'new');
  const [name, setName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [groupId, setGroupId] = React.useState<string | null>(params?.groupId ?? null);
  // Each choice with the group it was made for (R2-1), never a bare id set.
  const [choices, setChoices] = React.useState<ReadonlyMap<string, GroupRecordChoice>>(
    () => new Map(),
  );
  const [ackFamily, setAckFamily] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const [loadState, setLoadState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; review: PhoneGroupingReview; identity: GroupingIdentity }
  >({ kind: 'loading' });
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'done'>('ready');
  const [outcome, setOutcome] = React.useState<GroupingOutcome | null>(null);
  const [saveError, setSaveError] = React.useState<{ message: string; stale: boolean } | null>(
    null,
  );
  const pending = React.useRef<PendingGroupingBody | null>(null);
  const seq = React.useRef(0);
  // The pinned footer's measured height. The list reserves what the footer
  // really takes, however many buttons it holds and whatever the device's
  // bottom inset (the 170 it always reserved stays the floor), so the last
  // line can always scroll clear of it. Ungroup's twin needed it first.
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);

  const targetGroupId = mode === 'existing' ? groupId : null;
  const idsKey = itemIds.join(',');

  // The newest review for these records and this target; an overtaken answer
  // is dropped.
  React.useEffect(() => {
    if (!params || !activeOrgId || !user?.id) return;
    const mine = ++seq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new look at the records: the loading flag, then post-await sets
    setLoadState({ kind: 'loading' });
    const ids = idsKey ? idsKey.split(',') : [];
    void (async () => {
      if (!(await isOnline())) {
        if (mine === seq.current) setLoadState({ kind: 'offline' });
        return;
      }
      try {
        const r = await previewGrouping({
          itemIds: ids,
          groupId: targetGroupId,
          organizationId: activeOrgId,
          actorUserId: user.id,
        });
        if (mine !== seq.current) return;
        setLoadState({ kind: 'ready', review: r.review, identity: r.identity });
        // R2-1: the review that arrives drops every choice made for a group
        // its record is no longer in, so the member decides again.
        setChoices((cur) => choicesForReview(cur, r.review.records));
      } catch (e) {
        if (mine !== seq.current) return;
        setLoadState({ kind: 'failed', message: describeGroupingError(e).message });
      }
    })();
  }, [params, activeOrgId, user?.id, idsKey, targetGroupId, nonce]);

  const review = loadState.kind === 'ready' ? loadState.review : null;
  const identity = loadState.kind === 'ready' ? loadState.identity : null;

  // The name: a suggestion from the records (an editable field, never a link
  // made on a name) until the person types one.
  const nameValue = nameTouched ? name : review ? suggestGroupName(review.records, view) : '';
  const target: GroupDialogTarget =
    mode === 'new' ? { kind: 'new', name: nameValue } : { kind: 'existing', groupId };
  // Only the choices that hold for this review (R2-1).
  const decisions = React.useMemo(
    () => groupingDecisionsFor(choices, review?.records ?? [], ackFamily),
    [choices, review, ackFamily],
  );
  const plan = React.useMemo(
    () => (review ? planGrouping(itemIds, review, target, decisions) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from mode/nameValue/groupId
    [review, itemIds, mode, nameValue, groupId, decisions],
  );

  /** One record's choice when it is in another group (P10): move it here, or
   *  leave it out (not sent; it stays where it is). Kept with the group the
   *  record is in as the member chooses (R2-1). */
  function choose(id: string, choice: 'move' | 'leave', fromGroupId: string) {
    setChoices((cur) => new Map(cur).set(id, { choice, fromGroupId }));
  }

  // P11: announce the review's load outcome (records ready, a failure's own
  // words, offline) once per change, and each new reason Save is off.
  const loadAnnounced = React.useRef<ReviewLoadState>({ kind: 'loading' });
  React.useEffect(() => {
    const next: ReviewLoadState =
      loadState.kind === 'ready'
        ? { kind: 'ready', records: loadState.review.records.length }
        : loadState.kind === 'failed'
          ? { kind: 'failed', message: loadState.message }
          : loadState.kind === 'offline'
            ? { kind: 'offline' }
            : { kind: 'loading' };
    const message = reviewAnnouncement(loadAnnounced.current, next);
    loadAnnounced.current = next;
    if (message) announce(message);
  }, [loadState]);
  const blocked = plan && !plan.noop ? plan.blockedReason : null;
  const blockedAnnounced = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (blocked && blocked !== blockedAnnounced.current) announce(blocked);
    blockedAnnounced.current = blocked;
  }, [blocked]);

  async function save() {
    if (!plan || !identity || phase === 'saving') return;
    Keyboard.dismiss();
    if (plan.noop) {
      // Nothing to write: the records are already where this puts them.
      setOutcome({
        action: 'group',
        outcome: 'noop',
        replay: false,
        created: false,
        group: {
          id: plan.noop.groupId,
          name: plan.noop.name,
          version: 0,
          itemType: '',
          closed: false,
        },
        changes: [],
      });
      setPhase('done');
      announce(GROUP_COPY.noop(plan.noop.name));
      return;
    }
    if (!plan.canSave) return;
    pending.current = keyedGroupingBody(
      pending.current,
      groupBodyForPlan(plan, target, decisions, { idempotencyKey: 'pending', ...identity }),
    );
    setSaveError(null);
    setPhase('saving');
    try {
      const o = await postGrouping(pending.current.body);
      pending.current = null;
      setOutcome(o);
      setPhase('done');
      if (o.outcome === 'applied') notifyDisplayGroupsChanged();
      announce(
        o.outcome === 'noop'
          ? GROUP_COPY.noop(o.group?.name ?? '')
          : GROUP_COPY.done(o.group?.name ?? ''),
      );
    } catch (e) {
      const { message, retrySame } = describeGroupingError(e);
      // Kept with its key only when the SAME body may be sent again.
      if (!retrySame) pending.current = null;
      setSaveError({ message, stale: !retrySame });
      setPhase('ready');
      announce(message);
    }
  }

  function close() {
    if (phase === 'saving') return;
    if (outcome?.outcome === 'applied') {
      // The grouped records leave the shared selection, as on the web.
      for (const id of itemIds) countSelection.remove(id);
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function reviewAgain() {
    pending.current = null;
    setSaveError(null);
    setNonce((n) => n + 1);
  }

  const reviewById = new Map((review?.records ?? []).map((r) => [r.id, r]));
  const records = (plan?.records ?? []).flatMap((r) => {
    const full = reviewById.get(r.id);
    return full ? [full] : [];
  });
  const leftOutReason = new Map((plan?.leftOut ?? []).map((l) => [l.id, l.reason]));
  const siblings = plan?.conflicts.sameSkuSiblings ?? [];
  const editions = plan?.conflicts.editions ?? null;
  const showEditions = editions !== null && (editions.editions > 1 || editions.unknown > 0);
  const candidates = review?.candidateGroups ?? [];
  const sendCount = plan?.send.length ?? 0;
  const targetName =
    mode === 'existing'
      ? (review?.targetGroup?.name ?? candidates.find((g) => g.id === groupId)?.name ?? '')
      : (normalizeGroupName(nameValue) ?? '');
  const targetMembers = mode === 'existing' && plan ? plan.targetMembers : [];
  const busy = phase === 'saving';

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={close} accessibilityLabel="Back" minTap />
        </View>
        <View style={styles.head}>
          <Eyebrow>{view === 'books' ? 'BOOKS · GROUP' : 'ITEMS · GROUP'}</Eyebrow>
          <Display size={30} style={{ marginTop: 12 }}>
            {GROUP_COPY.title(itemIds.length)}
          </Display>
          <Body muted size={13.5} style={{ marginTop: 8 }}>
            {GROUP_COPY.intro}
          </Body>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: footerReservation(footerHeight, 170),
          gap: 16,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {!params ? (
          <Body muted size={13.5}>
            {GROUPING_ERROR_WORDS.invalid}
          </Body>
        ) : phase === 'done' && outcome ? (
          <Card padding={16}>
            <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
              <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                {outcome.outcome === 'noop'
                  ? GROUP_COPY.noop(outcome.group?.name ?? '')
                  : GROUP_COPY.done(outcome.group?.name ?? '')}
              </Body>
              <Body muted size={13}>
                {GROUP_COPY.skuNote}
              </Body>
            </View>
          </Card>
        ) : loadState.kind === 'loading' ? (
          <View style={styles.loading} accessibilityLiveRegion="polite">
            <ActivityIndicator color={c.ink} />
            <Body muted size={13}>
              Loading the records…
            </Body>
          </View>
        ) : loadState.kind === 'offline' || loadState.kind === 'failed' ? (
          <View style={{ gap: 12 }} accessibilityLiveRegion="polite">
            <Body size={14} color={c.ink}>
              {loadState.kind === 'offline' ? GROUP_COPY.offline : loadState.message}
            </Body>
            <Button
              variant="outline"
              size="sm"
              style={styles.smallButton}
              onPress={() => {
                // Never the same request when it could only fail again: more
                // records than one request takes fall back to the ones the
                // screen opened with (R2-4).
                setItemIds((cur) => reviewIdsForRetry(cur, params?.itemIds ?? []));
                setNonce((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </View>
        ) : (
          <>
            <Card padding={0}>
              {records.map((r, i) => {
                const reason = leftOutReason.get(r.id);
                const other =
                  r.displayGroup && r.displayGroup.id !== targetGroupId ? r.displayGroup : null;
                const inTarget = !!targetGroupId && r.displayGroup?.id === targetGroupId;
                const moving = decisions.moveIds.has(r.id);
                const leaving = decisions.leaveOutIds.has(r.id);
                return (
                  <View key={r.id}>
                    <View style={styles.recordRow}>
                      <Thumb
                        size={44}
                        icon={r.itemType === 'book' ? BookMarked : undefined}
                        imageUrl={r.imageUrl}
                        recyclingKey={r.id}
                      />
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <Body size={14.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                          {r.name}
                        </Body>
                        {/* SKU or ISBN, size, charter, rack, warehouse and on
                            hand: information, so the muted ink (the faint
                            ink4 held it under AA). */}
                        <Mono size={11.5} color={c.ink3} tracking={0.02}>
                          {reviewRecordDetail(r, view)}
                        </Mono>
                        {reason && reason !== 'chosen' ? (
                          <Body muted size={12}>
                            {`Left out: ${r.name} ${GROUP_COPY.leftOutReason[reason]}.`}
                          </Body>
                        ) : null}
                        {!reason && inTarget ? (
                          <Body muted size={12}>
                            {GROUP_COPY.alreadyInTarget}
                          </Body>
                        ) : null}
                        {(!reason || reason === 'chosen') && other ? (
                          // One explicit choice per record (P10): move it
                          // here, or leave it out (it stays in its group).
                          <View accessibilityRole="radiogroup" style={{ gap: 2 }}>
                            <Body size={12.5} color={c.ink}>
                              {GROUP_COPY.otherGroup(other.name)}
                            </Body>
                            {(
                              [
                                ['move', moving, GROUP_COPY.moveOne, GROUP_COPY.moveOneFor(r.name)],
                                [
                                  'leave',
                                  leaving,
                                  GROUP_COPY.leaveOutOne,
                                  GROUP_COPY.leaveOutOneFor(r.name),
                                ],
                              ] as const
                            ).map(([choice, on, label, a11yLabel]) => (
                              <Pressable
                                key={choice}
                                onPress={() => choose(r.id, choice, other.id)}
                                disabled={busy}
                                accessibilityRole="radio"
                                accessibilityLabel={a11yLabel}
                                accessibilityState={{ checked: on, disabled: busy }}
                                style={styles.choiceRow}
                              >
                                {on ? (
                                  <CircleDot size={20} color={c.ink} strokeWidth={2} />
                                ) : (
                                  <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                                )}
                                <Body size={12.5} color={c.ink} style={{ flex: 1 }}>
                                  {label}
                                </Body>
                              </Pressable>
                            ))}
                          </View>
                        ) : null}
                        {!reason && r.productGroupId && !inTarget ? (
                          <Body muted size={12}>
                            {GROUP_COPY.family(r.productGroupName)}
                          </Body>
                        ) : null}
                      </View>
                    </View>
                    {i < records.length - 1 ? <Hair inset={72} /> : null}
                  </View>
                );
              })}
            </Card>

            {plan && plan.unavailableCount > 0 ? (
              <Body muted size={12.5}>
                {GROUP_COPY.unavailable(plan.unavailableCount)}
              </Body>
            ) : null}

            {(plan?.conflicts.family.length ?? 0) > 0 ? (
              // The shared Checkbox (P2.5b): nothing around it is pressable,
              // so it is the whole control. Same role, state, words and
              // toggle (the updater, so `next` is not needed); the label is
              // now its spoken name, the words VoiceOver read before.
              <Checkbox
                checked={ackFamily}
                onChange={() => setAckFamily((v) => !v)}
                disabled={busy}
                label={GROUP_COPY.acknowledgeFamily}
              />
            ) : null}

            {siblings.length > 0 ? (
              <View style={{ gap: 8 }}>
                {[...new Set(siblings.map((s) => s.sku))].map((sku) => (
                  <Body key={sku} muted size={12.5}>
                    {GROUP_COPY.sameSku(siblings.filter((s) => s.sku === sku).length, sku)}
                  </Body>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  style={styles.smallButton}
                  // One request reviews at most 100 records: past that the
                  // review could only fail, so the button is off and says why
                  // (recheck R2-4).
                  disabled={busy || !!plan?.addSiblingsBlockedReason}
                  accessibilityHint={plan?.addSiblingsBlockedReason ?? undefined}
                  onPress={() => {
                    if (plan?.addSiblingsBlockedReason) return;
                    setItemIds((cur) => [...new Set([...cur, ...siblings.map((s) => s.id)])]);
                  }}
                >
                  {GROUP_COPY.addSiblings}
                </Button>
                {plan?.addSiblingsBlockedReason ? (
                  <Body muted size={12.5}>
                    {plan.addSiblingsBlockedReason}
                  </Body>
                ) : null}
              </View>
            ) : null}

            {showEditions && editions ? (
              <Body muted size={12.5}>
                {editions.unknown > 0
                  ? GROUP_COPY.editionsUnknown
                  : GROUP_COPY.editions(editions.editions)}
              </Body>
            ) : null}

            <View style={{ gap: 10 }}>
              {/* A section heading: the muted ink (ink4 held it under AA),
                  and a header for VoiceOver's rotor. */}
              <Mono size={11} tracking={0.14} upper color={c.ink3} accessibilityRole="header">
                Where they go
              </Mono>
              <Card padding={0}>
                <Pressable
                  onPress={() => setMode('new')}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: mode === 'new', disabled: busy }}
                  style={styles.radioRow}
                >
                  {mode === 'new' ? (
                    <CircleDot size={20} color={c.ink} strokeWidth={2} />
                  ) : (
                    <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                  )}
                  <Body size={14} color={c.ink} style={{ flex: 1 }}>
                    {GROUP_COPY.targetNew}
                  </Body>
                </Pressable>
                {mode === 'new' ? (
                  // The shared Field: its label above (muted ink, where the
                  // faint ink4 held it under AA), the stronger border that
                  // turns ink while typing, and the 24pt input ceiling.
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
                    <Field
                      label={GROUP_COPY.nameLabel}
                      value={nameValue}
                      onChangeText={(t) => {
                        setNameTouched(true);
                        setName(t);
                      }}
                      editable={!busy}
                      maxLength={GROUP_NAME_MAX_LENGTH}
                      accessibilityLabel={GROUP_COPY.nameLabel}
                      maxFontSizeMultiplier={capTo(16, TYPE_CEILING.input)}
                    />
                  </View>
                ) : null}
                <Hair />
                <Pressable
                  onPress={() => setMode('existing')}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: mode === 'existing', disabled: busy }}
                  style={styles.radioRow}
                >
                  {mode === 'existing' ? (
                    <CircleDot size={20} color={c.ink} strokeWidth={2} />
                  ) : (
                    <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                  )}
                  <Body size={14} color={c.ink} style={{ flex: 1 }}>
                    {GROUP_COPY.targetExisting}
                  </Body>
                </Pressable>
                {mode === 'existing' ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 4 }}>
                    {candidates.length === 0 && !groupId ? (
                      <Body muted size={12.5}>
                        {GROUP_COPY.noCandidates}
                      </Body>
                    ) : (
                      [
                        ...candidates.map((g) => ({
                          id: g.id,
                          label: `${g.name} (${GROUP_COPY.headerRecords(g.memberCount)})`,
                        })),
                        ...(groupId &&
                        !candidates.some((g) => g.id === groupId) &&
                        review?.targetGroup
                          ? [{ id: groupId, label: review.targetGroup.name }]
                          : []),
                      ].map((g) => (
                        <Pressable
                          key={g.id}
                          onPress={() => setGroupId(g.id)}
                          disabled={busy}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: groupId === g.id, disabled: busy }}
                          style={styles.choiceRow}
                        >
                          {groupId === g.id ? (
                            <CircleDot size={18} color={c.ink} strokeWidth={2} />
                          ) : (
                            <Circle size={18} color={c.ink4} strokeWidth={1.6} />
                          )}
                          <Body size={13.5} color={c.ink} style={{ flex: 1 }}>
                            {g.label}
                          </Body>
                        </Pressable>
                      ))
                    )}
                  </View>
                ) : null}
              </Card>
            </View>

            {plan?.previewHeader ? (
              <View style={{ gap: 6 }}>
                <Mono size={11} tracking={0.14} upper color={c.ink3} accessibilityRole="header">
                  {GROUP_COPY.previewLabel}
                </Mono>
                {/* The list's group-header recipe, the recessed fill (sunk):
                    this is how the header will show on the list. */}
                <View
                  style={[styles.previewHeader, { backgroundColor: c.sunk, borderColor: c.hair }]}
                >
                  <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                    {plan.previewHeader}
                  </Body>
                </View>
                {targetMembers.length > 0 ? (
                  // The group's other records the member can see (P8).
                  <View style={{ gap: 3, paddingTop: 4 }}>
                    <Mono size={11} tracking={0.04} color={c.ink3}>
                      {GROUP_COPY.targetMembers(targetName)}
                    </Mono>
                    {targetMembers.slice(0, TARGET_MEMBERS_SHOWN).map((m) => (
                      <Body key={m.id} muted size={12.5}>
                        {[m.name, m.sku ? `SKU ${m.sku}` : null, `${m.quantityOnHand} on hand`]
                          .filter(Boolean)
                          .join(' · ')}
                      </Body>
                    ))}
                    {targetMembers.length > TARGET_MEMBERS_SHOWN ? (
                      <Body muted size={12.5}>
                        {GROUP_COPY.moreTargetMembers(targetMembers.length - TARGET_MEMBERS_SHOWN)}
                      </Body>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}

            <Body muted size={12.5}>
              {GROUP_COPY.skuNote}
            </Body>

            {plan?.noop ? (
              <Body size={13} color={c.ink} accessibilityLiveRegion="polite">
                {GROUP_COPY.noop(plan.noop.name)}
              </Body>
            ) : plan?.blockedReason ? (
              <Body muted size={13} accessibilityLiveRegion="polite">
                {plan.blockedReason}
              </Body>
            ) : null}

            {saveError ? (
              <Body size={13.5} color={c.critText} accessibilityLiveRegion="assertive">
                {saveError.message}
              </Body>
            ) : null}
          </>
        )}
      </ScrollView>

      <SafeAreaView
        edges={['bottom']}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}
      >
        {phase === 'done' ? (
          <Button block onPress={close}>
            Done
          </Button>
        ) : (
          <View style={{ gap: 10 }}>
            {saveError?.stale ? (
              <Button block variant="outline" onPress={reviewAgain}>
                Review again
              </Button>
            ) : loadState.kind === 'ready' && plan ? (
              <Button
                block
                onPress={() => void save()}
                disabled={busy || !identity || (!plan.noop && !plan.canSave)}
                leading={busy ? <ActivityIndicator size="small" color={c.paper} /> : undefined}
              >
                {plan.noop
                  ? GROUP_COPY.noopConfirm
                  : mode === 'existing' && targetName
                    ? GROUP_COPY.confirmExisting(plan.joining.length, targetName)
                    : GROUP_COPY.confirmNew(sendCount)}
              </Button>
            ) : null}
            <Button block variant="ghost" onPress={close} disabled={busy}>
              {GROUP_COPY.cancel}
            </Button>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding, as on New count.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 12 },
  loading: { paddingVertical: 28, alignItems: 'center', gap: 10 },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  // A 44pt row: the whole line is the target, not the 20pt mark.
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  previewHeader: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  // Try again and Add them to the selection: the small button's look in a
  // 44pt target (the small size is 36pt). minHeight, so it still grows.
  smallButton: {
    minHeight: 44,
  },
  // Pinned over the scrolling review, so a hairline marks its top edge.
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    borderTopWidth: 1,
  },
});
