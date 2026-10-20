import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, BookMarked, Circle, CircleDot } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  familyStaysListedByName,
  familySkuTogether,
  familyStaysListedByNameAfter,
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  keyedUngroupSelectedBody,
  planUngroupSelected,
  randomRequestUuid,
  ungroupAnchorFor,
  ungroupChangeCount,
  ungroupListMayBeStale,
  UNGROUP_COPY,
  ungroupOutcomeWords,
  ungroupRackLine,
  ungroupRecordOutcome,
  ungroupResultLines,
  ungroupSelectedBodyForPlan,
  type UngroupSelectedBody,
  type UngroupSelectedOutcome,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useAuth } from '@/lib/auth-context';
import {
  describeGroupingError,
  notifyDisplayGroupsChanged,
  reviewRecordDetail,
  type GroupingIdentity,
} from '@/lib/display-groups';
import { footerReservation } from '@/lib/dynamic-type-layout';
import { isOnline } from '@/lib/sync';
import { FONT } from '@/lib/theme';
import {
  keepsSkuRadioLabels,
  notifyRecordsUngrouped,
  postUngroupSelected,
  previewUngroupSelected,
  readUngroupSelectedParams,
  ungroupSelectedReviewKey,
  type PhoneUngroupReview,
  type UngroupSelectedParams,
} from '@/lib/ungroup-selected';
import { countSelection } from '@/lib/use-count-selection';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * Ungroup for any ticked records on the phone (owner 2026-10-12, Ungroup
 * anything): the review before anything is written, the twin of the web's
 * UngroupSelectedDialog over the same service and the same core plan and
 * words. Every ticked record the member can read is listed with its line and
 * what happens to it, by the grouping it is shown under on the list: "Gets its
 * own SKU" (or "Keeps SKU X" for the one that keeps a fully ticked SKU, chosen
 * here), "Leaves group <name>", "Leaves the <family> size family" (with the
 * Returns exchange note), or "Left out" and why. Save counts the records that
 * change.
 *
 * ONLINE ONLY and never queued. Cancel writes nothing. Save sends one body
 * whose keyed steps keep their keys for a retry of the same body (busy, a lost
 * answer), so the database replays; the answer names every step, and a step
 * refused after an earlier one applied is said with what applied.
 */

/** Says a message to VoiceOver or TalkBack now (iOS ignores live regions). */
function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

export default function UngroupSelectedScreen() {
  const {
    ids: idsParam,
    view: viewParam,
    under: underParam,
  } = useLocalSearchParams<{ ids?: string; view?: string; under?: string }>();
  const params = React.useMemo(
    () => readUngroupSelectedParams({ ids: idsParam, view: viewParam, under: underParam }),
    [idsParam, viewParam, underParam],
  );
  // A fresh review whenever the route names other records, another list or
  // another grouping a record is shown under (ungroupSelectedReviewKey,
  // redesign Stage 6 F8): expo-router REUSES this screen when a link to it
  // arrives while it is on top, swapping only the params. The reload below
  // reset most of the review, but a refused Save's error (and its Review
  // again) stayed over the new records, and the old review or result showed
  // under the new params until the reload ran. The same selection, in any
  // order or case, keeps its review and the person's choices: the review
  // holds the params it was mounted with.
  return <UngroupSelectedReview key={ungroupSelectedReviewKey(params)} params={params} />;
}

/** The review itself. Every piece of its state belongs to the selection it
 *  was mounted for: the route mounts a new one for another selection. */
function UngroupSelectedReview({ params: routeParams }: { params: UngroupSelectedParams | null }) {
  // The selection the review was mounted for, kept for its whole life. The
  // route mounts a new review for any other selection, so later params can
  // only name this one in another order or case. Reading them ran the reload
  // below again, which cleared the person's keeps-the-SKU choice, any result
  // shown and its Try again (redesign Stage 6, F8 review).
  const [params] = React.useState(routeParams);
  const router = useRouter();
  const { c } = useTheme();
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const view = params?.view ?? 'items';
  const idsKey = params?.itemIds.join(',') ?? '';

  const [loadState, setLoadState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; data: PhoneUngroupReview; identity: GroupingIdentity }
  >({ kind: 'loading' });
  const [nonce, setNonce] = React.useState(0);
  const [anchorBySku, setAnchorBySku] = React.useState<Record<string, string>>({});
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'done'>('ready');
  const [outcome, setOutcome] = React.useState<UngroupSelectedOutcome | null>(null);
  const [saveError, setSaveError] = React.useState<{ message: string; stale: boolean } | null>(
    null,
  );
  // The body a result's Try again sends unchanged (keys and all).
  const [retryBody, setRetryBody] = React.useState<UngroupSelectedBody | null>(null);
  const pending = React.useRef<{ json: string; body: UngroupSelectedBody } | null>(null);
  const seq = React.useRef(0);
  // The pinned footer's measured height. A result with Try again, Review
  // again and Done is three buttons, about 220pt with the home indicator,
  // which is more than the 170 the list reserved: the last lines of a long
  // result sat under the footer. 170 stays the floor.
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);

  // The newest review for these records. An answer is dropped once the
  // effect runs again (seq) or the review unmounts (live, cleared by the
  // cleanup): a link for other records mounts a new review, and the old one
  // must not tell VoiceOver "2 records to review." for records no longer on
  // screen (redesign Stage 6, F8 review).
  React.useEffect(() => {
    if (!params || !activeOrgId || !user?.id) return;
    const mine = ++seq.current;
    let live = true;
    pending.current = null;
    /* eslint-disable react-hooks/set-state-in-effect -- a new look at the records: reset, then post-await sets */
    setLoadState({ kind: 'loading' });
    setOutcome(null);
    setRetryBody(null);
    setPhase('ready');
    setAnchorBySku({});
    /* eslint-enable react-hooks/set-state-in-effect */
    const ids = idsKey ? idsKey.split(',') : [];
    void (async () => {
      if (!(await isOnline())) {
        if (live && mine === seq.current) setLoadState({ kind: 'offline' });
        return;
      }
      try {
        const r = await previewUngroupSelected({
          itemIds: ids,
          organizationId: activeOrgId,
          actorUserId: user.id,
        });
        if (!live || mine !== seq.current) return;
        setLoadState({ kind: 'ready', data: r, identity: r.identity });
        announce(GROUP_COPY.reviewReady(r.review.records.length));
      } catch (e) {
        if (!live || mine !== seq.current) return;
        const { message } = describeGroupingError(e);
        setLoadState({ kind: 'failed', message });
        announce(message);
      }
    })();
    return () => {
      live = false;
    };
  }, [params, activeOrgId, user?.id, idsKey, nonce]);

  const data = loadState.kind === 'ready' ? loadState.data : null;
  const identity = loadState.kind === 'ready' ? loadState.identity : null;
  const plan = React.useMemo(
    () =>
      data && params
        ? planUngroupSelected(params.itemIds, data.review, data.candidates, {
            canUnlinkFamilies: data.canUnlinkFamilies,
            shownUnder: params.shownUnder,
          })
        : null,
    [data, params],
  );
  // Every "keeps the SKU" radio's name, by record, worked out once per plan
  // (redesign Stage 6, F9 review): naming each radio as it rendered rebuilt
  // every other record's line twice, 20,000 lines on every tap for a SKU of
  // 100 ticked records.
  const radioNames = React.useMemo(
    () =>
      new Map(
        plan
          ? plan.split.groups
              .filter((g) => g.allSelected)
              .flatMap((g) => [
                ...keepsSkuRadioLabels(
                  UNGROUP_COPY.keepsSku(g.sku),
                  plan.records,
                  g.selected,
                  view,
                ),
              ])
          : [],
      ),
    [plan, view],
  );
  const changing = plan ? ungroupChangeCount(plan, anchorBySku) : 0;
  const reviewById = new Map((data?.review.records ?? []).map((r) => [r.id, r]));

  async function send(body: UngroupSelectedBody) {
    setSaveError(null);
    setPhase('saving');
    try {
      const o = await postUngroupSelected(body);
      const again = !o.complete && o.parts.some((p) => p.retryable);
      if (!again) pending.current = null;
      setRetryBody(again ? body : null);
      setOutcome(o);
      setPhase('done');
      if (ungroupListMayBeStale(o)) {
        notifyRecordsUngrouped();
        notifyDisplayGroupsChanged();
      }
      const lines = ungroupResultLines(o);
      announce([...lines.done, ...lines.notDone].join(' '));
    } catch (e) {
      // A refusal before any write. Kept with its keys only when the SAME
      // body may be sent again (busy, a rate limit, or no answer at all: if it
      // did arrive, the retry replays it).
      const { message, retrySame } = describeGroupingError(e);
      const stale = !retrySame;
      if (stale) pending.current = null;
      setSaveError({ message, stale });
      setPhase('ready');
      announce(message);
    }
  }

  async function save() {
    if (!plan || !identity || changing === 0 || phase === 'saving') return;
    pending.current = keyedUngroupSelectedBody(
      pending.current,
      ungroupSelectedBodyForPlan(plan, anchorBySku, {
        organizationId: identity.organizationId,
        actorUserId: identity.actorUserId,
        removeKey: 'pending',
        splitKey: 'pending',
      }),
      randomRequestUuid,
    );
    await send(pending.current.body);
  }

  function close() {
    if (phase === 'saving') return;
    if (outcome && outcome.parts.some((p) => p.changedItemIds.length > 0)) {
      // The records that changed leave the shared selection, as on the web.
      for (const p of outcome.parts) for (const id of p.changedItemIds) countSelection.remove(id);
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function reviewAgain() {
    pending.current = null;
    setSaveError(null);
    setNonce((n) => n + 1);
  }

  const busy = phase === 'saving';
  const lines = outcome ? ungroupResultLines(outcome) : null;
  const firstOfSku = new Set(
    (plan?.split.groups ?? []).filter((g) => g.allSelected).map((g) => g.selected[0]?.id),
  );

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={close} accessibilityLabel="Back" minTap />
        </View>
        <View style={styles.head}>
          <Eyebrow>{view === 'books' ? 'BOOKS · UNGROUP' : 'ITEMS · UNGROUP'}</Eyebrow>
          <Display size={30} style={{ marginTop: 12 }}>
            {UNGROUP_COPY.selectedTitle}
          </Display>
          <Body muted size={13.5} style={{ marginTop: 8 }}>
            {UNGROUP_COPY.selectedIntro}
          </Body>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: footerReservation(footerHeight, 170),
          gap: 16,
        }}
      >
        {!params ? (
          <Body muted size={13.5}>
            {GROUPING_ERROR_WORDS.invalid}
          </Body>
        ) : phase === 'done' && outcome && lines ? (
          <Card padding={16}>
            <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
              {lines.done.map((l) => (
                <Body key={l} size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {l}
                </Body>
              ))}
              {(outcome.parts.find((p) => p.kind === 'split')?.splitItems ?? [])
                .filter((i) => !i.kept)
                .map((i) => (
                  <Mono key={i.id} size={11.5} color={c.ink3}>
                    {`${reviewById.get(i.id)?.name ?? 'Record'}: ${i.beforeSku} → ${i.afterSku}`}
                  </Mono>
                ))}
              {familyStaysListedByNameAfter(outcome, (x) => reviewById.get(x)?.name, view) ? (
                <Body size={13.5} color={c.ink}>
                  {UNGROUP_COPY.familyNameNote}
                </Body>
              ) : null}
              {lines.notDone.map((l) => (
                <Body key={l} size={13.5} color={c.critText}>
                  {l}
                </Body>
              ))}
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
              {loadState.kind === 'offline' ? UNGROUP_COPY.selectedOffline : loadState.message}
            </Body>
            <Button
              variant="outline"
              size="sm"
              style={styles.smallButton}
              onPress={() => setNonce((n) => n + 1)}
            >
              Try again
            </Button>
          </View>
        ) : plan ? (
          <>
            <Card padding={0}>
              {plan.records.map((rec, i) => {
                const r = reviewById.get(rec.id);
                const o = ungroupRecordOutcome(plan, rec.id, anchorBySku);
                if (!r || !o) return null;
                const group =
                  o.kind === 'split'
                    ? plan.split.groups.find((g) => g.selected.some((x) => x.id === rec.id))
                    : undefined;
                const keeps = group ? ungroupAnchorFor(group, anchorBySku) === rec.id : false;
                return (
                  <View key={rec.id}>
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
                        {/* The record's line: information, so the muted ink
                            (the faint ink4 held it under AA). */}
                        <Mono size={11.5} color={c.ink3} tracking={0.02}>
                          {reviewRecordDetail(r, view)}
                        </Mono>
                        {group?.allSelected && firstOfSku.has(rec.id) ? (
                          <Body muted size={12}>
                            {`SKU ${group.sku}: ${UNGROUP_COPY.anchorLegend}`}
                          </Body>
                        ) : null}
                        {group?.allSelected ? (
                          // Named for its record and for what tells it apart
                          // from the SKU's other records, with the outcome
                          // beside it as its value: three Wireless Mouse
                          // radios read the same, and the outcome was never
                          // heard (redesign Stage 6, F9).
                          <Pressable
                            onPress={() => setAnchorBySku((m) => ({ ...m, [group.sku]: rec.id }))}
                            disabled={busy}
                            accessibilityRole="radio"
                            accessibilityLabel={radioNames.get(rec.id)}
                            accessibilityValue={{ text: ungroupOutcomeWords(o) }}
                            accessibilityState={{ checked: keeps, disabled: busy }}
                            style={styles.choiceRow}
                          >
                            {keeps ? (
                              <CircleDot size={20} color={c.ink} strokeWidth={2} />
                            ) : (
                              <Circle size={20} color={c.ink4} strokeWidth={1.6} />
                            )}
                            <Body size={12.5} color={c.ink} style={{ flex: 1 }}>
                              {ungroupOutcomeWords(o)}
                            </Body>
                          </Pressable>
                        ) : (
                          <Body
                            size={12.5}
                            color={o.kind === 'left_out' ? c.ink3 : c.ink}
                            style={o.kind === 'left_out' ? undefined : { fontFamily: FONT.display }}
                          >
                            {ungroupOutcomeWords(o)}
                          </Body>
                        )}
                        {plan.familySkuSiblings.get(rec.id) ? (
                          // The other racks' records of its SKU leave the
                          // family with it (owner 2026-10-12, "Move them together").
                          <View style={{ gap: 2 }}>
                            <Body muted size={12}>
                              {UNGROUP_COPY.familySkuWith}
                            </Body>
                            {plan.familySkuSiblings.get(rec.id)!.map((x) => (
                              <Body key={x.id} size={12} color={c.ink}>
                                {`${x.name} · ${ungroupRackLine(x)}`}
                              </Body>
                            ))}
                          </View>
                        ) : null}
                      </View>
                    </View>
                    {i < plan.records.length - 1 ? <Hair inset={72} /> : null}
                  </View>
                );
              })}
            </Card>

            {plan.unavailableCount > 0 ? (
              <Body muted size={12.5}>
                {GROUP_COPY.unavailable(plan.unavailableCount)}
              </Body>
            ) : null}
            {plan.split.groups
              .filter((g) => !g.allSelected)
              .map((g) => (
                <Body key={g.sku} muted size={12.5}>
                  {UNGROUP_COPY.othersKeep(g.others.length, g.sku)}
                </Body>
              ))}
            {plan.groups.map((g) =>
              g.staying === null ? null : (
                <Body key={g.id} size={12.5} color={c.ink}>
                  {g.staying === 0
                    ? GROUP_COPY.removeLast(g.name)
                    : GROUP_COPY.removeStays(g.staying, g.name)}
                </Body>
              ),
            )}
            {plan.leaveFamily.length > 0 ? (
              <Body size={12.5} color={c.ink}>
                {UNGROUP_COPY.familyNote}
              </Body>
            ) : null}
            {familySkuTogether(plan) ? (
              <Body size={12.5} color={c.ink}>
                {UNGROUP_COPY.familySkuNote}
              </Body>
            ) : null}
            {familyStaysListedByName(plan.leaveFamily, view) ? (
              <Body size={12.5} color={c.ink}>
                {UNGROUP_COPY.familyNameNote}
              </Body>
            ) : null}
            {plan.split.splitIds.length > 0 ? (
              <Body muted size={12.5}>
                {UNGROUP_COPY.barcodeNote}
              </Body>
            ) : null}
            {changing === 0 ? (
              <Body size={13} color={c.ink} accessibilityLiveRegion="polite">
                {UNGROUP_COPY.selectedNothing}
              </Body>
            ) : null}
            {saveError ? (
              <Body size={13.5} color={c.critText} accessibilityLiveRegion="assertive">
                {saveError.message}
              </Body>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <SafeAreaView
        edges={['bottom']}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}
      >
        {phase === 'done' ? (
          <View style={{ gap: 10 }}>
            {outcome && !outcome.complete ? (
              <>
                {retryBody ? (
                  <Button block variant="outline" onPress={() => void send(retryBody)}>
                    Try again
                  </Button>
                ) : null}
                <Button block variant="outline" onPress={reviewAgain}>
                  Review again
                </Button>
              </>
            ) : null}
            <Button block onPress={close}>
              Done
            </Button>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {saveError?.stale ? (
              <Button block variant="outline" onPress={reviewAgain}>
                Review again
              </Button>
            ) : loadState.kind === 'ready' && plan && changing > 0 ? (
              <Button
                block
                onPress={() => void save()}
                disabled={busy || !identity}
                leading={busy ? <ActivityIndicator size="small" color={c.paper} /> : undefined}
              >
                {UNGROUP_COPY.confirm(changing)}
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
  // Try again: the small button's look in a 44pt target (the small size is
  // 36pt). minHeight, so it still grows.
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
