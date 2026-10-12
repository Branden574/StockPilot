import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, BookMarked, CheckCircle2, Circle, CircleDot } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  GROUP_NAME_MAX_LENGTH,
  groupBodyForPlan,
  normalizeGroupName,
  planGrouping,
  suggestGroupName,
  type GroupDialogTarget,
  type GroupingOutcome,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
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
  reviewRecordDetail,
  type GroupingIdentity,
  type PendingGroupingBody,
  type PhoneGroupingReview,
} from '@/lib/display-groups';
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
 * another group (never moved silently: "Move it into this group" per record,
 * or go back and deselect it); a product family it belongs to (confirmed,
 * never changed); records sharing a SKU that are not selected; and how the
 * list will show the group afterwards.
 *
 * ONLINE ONLY and never queued. Cancel writes nothing. Save sends one key per
 * body and keeps it for a retry of that body (busy, a lost answer), so the
 * database replays the first outcome instead of making a second group; a
 * repeat after it applied answers that the records are already there.
 */
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
  const [moveIds, setMoveIds] = React.useState<Set<string>>(new Set());
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
  const plan = React.useMemo(
    () =>
      review
        ? planGrouping(itemIds, review, target, { moveIds, acknowledgeFamily: ackFamily })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from mode/nameValue/groupId
    [review, itemIds, mode, nameValue, groupId, moveIds, ackFamily],
  );

  function announce(message: string) {
    AccessibilityInfo.announceForAccessibility(message);
  }

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
      groupBodyForPlan(
        plan,
        target,
        { moveIds, acknowledgeFamily: ackFamily },
        { idempotencyKey: 'pending', ...identity },
      ),
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
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 170, gap: 16 }}
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
            <Button variant="outline" size="sm" onPress={() => setNonce((n) => n + 1)}>
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
                const moving = moveIds.has(r.id);
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
                        <Mono size={11} color={c.ink4} tracking={0.02}>
                          {reviewRecordDetail(r, view)}
                        </Mono>
                        {reason ? (
                          <Body muted size={12}>
                            {`Left out: ${r.name} ${GROUP_COPY.leftOutReason[reason]}.`}
                          </Body>
                        ) : null}
                        {!reason && other ? (
                          <Pressable
                            onPress={() =>
                              setMoveIds((s) => {
                                const n = new Set(s);
                                if (n.has(r.id)) n.delete(r.id);
                                else n.add(r.id);
                                return n;
                              })
                            }
                            disabled={busy}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: moving, disabled: busy }}
                            style={styles.choiceRow}
                          >
                            {moving ? (
                              <CheckCircle2 size={20} color={c.ink} strokeWidth={2} />
                            ) : (
                              <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                            )}
                            <Body size={12.5} color={c.ink} style={{ flex: 1 }}>
                              {`${GROUP_COPY.otherGroup(other.name)} ${GROUP_COPY.moveOne}`}
                            </Body>
                          </Pressable>
                        ) : null}
                        {!reason &&
                        r.productGroupId &&
                        !(targetGroupId && r.displayGroup?.id === targetGroupId) ? (
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
              <Pressable
                onPress={() => setAckFamily((v) => !v)}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: ackFamily, disabled: busy }}
                style={styles.choiceRow}
              >
                {ackFamily ? (
                  <CheckCircle2 size={20} color={c.ink} strokeWidth={2} />
                ) : (
                  <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                )}
                <Body size={13} color={c.ink} style={{ flex: 1 }}>
                  {GROUP_COPY.acknowledgeFamily}
                </Body>
              </Pressable>
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
                  disabled={busy}
                  onPress={() =>
                    setItemIds((cur) => [...new Set([...cur, ...siblings.map((s) => s.id)])])
                  }
                >
                  {GROUP_COPY.addSiblings}
                </Button>
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
              <Mono size={11} tracking={0.14} upper color={c.ink4}>
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
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6 }}>
                    <Mono size={11} color={c.ink4} tracking={0.04}>
                      {GROUP_COPY.nameLabel}
                    </Mono>
                    <TextInput
                      value={nameValue}
                      onChangeText={(t) => {
                        setNameTouched(true);
                        setName(t);
                      }}
                      editable={!busy}
                      maxLength={GROUP_NAME_MAX_LENGTH}
                      accessibilityLabel={GROUP_COPY.nameLabel}
                      maxFontSizeMultiplier={capTo(15, TYPE_CEILING.input)}
                      style={[
                        styles.input,
                        {
                          backgroundColor: c.card,
                          borderColor: c.hair,
                          color: c.ink,
                          fontFamily: FONT.displayRegular,
                        },
                      ]}
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
                <Mono size={11} tracking={0.14} upper color={c.ink4}>
                  {GROUP_COPY.previewLabel}
                </Mono>
                <View
                  style={[styles.previewHeader, { backgroundColor: c.paper2, borderColor: c.hair }]}
                >
                  <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                    {plan.previewHeader}
                  </Body>
                </View>
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

      <SafeAreaView edges={['bottom']} style={[styles.footer, { backgroundColor: c.paper }]}>
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
                {mode === 'existing' && targetName
                  ? GROUP_COPY.confirmExisting(sendCount, targetName)
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
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  previewHeader: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
});
