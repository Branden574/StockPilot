'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { MissingPhoto } from '@/components/patterns/missing-photo';

import {
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  choicesForReview,
  groupBodyForPlan,
  groupingDecisionsFor,
  groupingPreviewKey,
  groupingRecordLine,
  normalizeGroupName,
  planGrouping,
  planRemoval,
  randomRequestUuid,
  removeBodyFor,
  suggestGroupName,
  type GroupDialogTarget,
  type GroupRecordChoice,
  type GroupingBody,
  type GroupingOutcome,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { groupChoiceRadioNames } from '@/lib/inventory/grouping-radio-names';
import { applyGroupingAction, previewGroupingAction } from '@/server/actions/item-grouping';
import type { GroupingReview, GroupingReviewRecord } from '@/server/services/item-grouping';

/**
 * Group selected (design-merged.md section 5, migration 0400): the review
 * dialog for the Items and Books bulk bar, plus Remove from group and Rename
 * for a group's header and the item page.
 *
 * Every dialog reads a preview first (item_grouping_preview, as the viewer):
 * the selected records the viewer can read (the rest are a count), each with
 * its picture, name, SKU (and ISBN for a book), size or edition, charter,
 * rack and on hand, its current group and product family, and whether the
 * viewer can edit it. Nothing is written until Save; Cancel writes nothing.
 *
 * THE KEY: minted at the first Save of a body and kept, with that body, for
 * every retry of it (busy, a lost answer): the database replays the first
 * outcome instead of making a second group. A different body or a new
 * preview mints a new one. A repeat with a new key is a no-op the database
 * answers with the group the records are already in.
 *
 * A record already in another group is never moved silently: Save stays off
 * until the person chooses, for that record, "Move it into this group" or
 * "Leave it out" (it is then not sent and stays where it is). Each choice is
 * kept with the group the record was in when it was made: a new review that
 * finds the record in another group (Review again after a colleague moved it)
 * drops the choice, so the person decides again (recheck R2-1). A
 * product-family member needs the confirmation; its family is not changed
 * either way. A preview that answers for another selection than the dialog
 * now holds is ignored (its key differs).
 *
 * Adding to an existing group lists the group's other records the person can
 * see, marks a selected record already in it, and counts on Save only the
 * records that join; same-SKU records already in the group are never said to
 * "stay outside" it (people review P1, P6, P8).
 */

/** Retry the same body only for these refusals; anything else needs a new look. */
const RETRY_SAME = new Set(['busy', 'rate_limited']);

/** How many of an existing group's other records the review lists by name
 *  (the header above counts them all). */
const TARGET_MEMBERS_SHOWN = 20;

type Identity = { organizationId: string; actorUserId: string };

/**
 * Whether a failed review may answer differently when it is read again: a
 * server error, a rate limit or a busy read (recheck R2-2). A refusal that the
 * same request cannot change (more records than one request takes, no
 * permission, a record or group that is gone, signed out) is not offered
 * again: its own words say what to do instead.
 */
function reviewMayRetry(error: { code: string; details?: Record<string, unknown> }): boolean {
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : error.code;
  return error.code === 'internal_error' || RETRY_SAME.has(error.code) || RETRY_SAME.has(reason);
}

/** The words for a review that got no answer at all: the connection when the
 *  browser says it is offline, else core's generic sentence. Never the raw
 *  error (a network failure, or "Failed to find Server Action" in a tab left
 *  open across a deploy). */
function reviewFailureWords(): string {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? GROUP_COPY.offline
    : GROUPING_ERROR_WORDS.internal;
}

/** The newest preview for these ids (and target), ignoring overtaken answers.
 *  A failed one (no answer, or a refusal) never leaves the dialog loading: it
 *  sets the words to show and whether Try again may help (recheck R2-2). */
function useGroupingReview(
  open: boolean,
  itemIds: readonly string[],
  groupId: string | null,
  nonce: number,
) {
  const [state, setState] = React.useState<{
    review: GroupingReview | null;
    identity: Identity | null;
    error: string | null;
    /** A second look may answer differently (Try again). */
    retry: boolean;
    loading: boolean;
  }>({ review: null, identity: null, error: null, retry: false, loading: true });
  const seq = React.useRef(0);
  const idsKey = itemIds.join(',');
  React.useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open / re-preview
    setState((s) => ({ ...s, loading: true, error: null, retry: false }));
    const ids = idsKey ? idsKey.split(',') : [];
    void previewGroupingAction(ids, groupId).then(
      (r) => {
        if (mine !== seq.current) return;
        if (!r.ok) {
          setState({
            review: null,
            identity: null,
            error: r.error.message || GROUPING_ERROR_WORDS.internal,
            retry: reviewMayRetry(r.error),
            loading: false,
          });
          return;
        }
        // An answer for another selection or target than this one is stale.
        if (r.data.review.previewKey !== groupingPreviewKey(r.data.organizationId, ids, groupId))
          return;
        setState({
          review: r.data.review,
          identity: { organizationId: r.data.organizationId, actorUserId: r.data.actorUserId },
          error: null,
          retry: false,
          loading: false,
        });
      },
      () => {
        // No answer at all: offline, a platform error, or a deployment that
        // no longer has this action. Reads only, so a second look is safe.
        if (mine !== seq.current) return;
        setState({
          review: null,
          identity: null,
          error: reviewFailureWords(),
          retry: true,
          loading: false,
        });
      },
    );
  }, [open, idsKey, groupId, nonce]);
  return state;
}

/** Save with a key kept for retries of the same body. */
function useKeyedSave() {
  const pending = React.useRef<{ json: string; body: GroupingBody } | null>(null);
  return {
    reset: () => {
      pending.current = null;
    },
    bodyFor: (draft: GroupingBody): GroupingBody => {
      const json = JSON.stringify({ ...draft, idempotencyKey: undefined });
      if (!pending.current || pending.current.json !== json) {
        pending.current = { json, body: { ...draft, idempotencyKey: randomRequestUuid() } };
      }
      return pending.current.body;
    },
  };
}

async function sendGrouping(
  body: GroupingBody,
): Promise<
  { ok: true; outcome: GroupingOutcome } | { ok: false; message: string; stale: boolean }
> {
  let r: Awaited<ReturnType<typeof applyGroupingAction>>;
  try {
    r = await applyGroupingAction(body);
  } catch {
    // No answer: it may or may not have applied. The SAME body and key stay
    // pending, so Save replays it if it did. Never the raw error.
    return { ok: false, message: GROUPING_ERROR_WORDS.internal, stale: false };
  }
  if (!r.ok) {
    const reason =
      typeof r.error.details?.reason === 'string' ? r.error.details.reason : r.error.code;
    return {
      ok: false,
      message: r.error.message || GROUPING_ERROR_WORDS.internal,
      stale: !RETRY_SAME.has(reason),
    };
  }
  return { ok: true, outcome: r.data.outcome };
}

/** A text field or select in these reviews: the shared field look (DESIGN-SPEC
 *  6.3), 32 px with the stronger hairline and the focus ring; 44 px with 16 px
 *  text below sm. */
const FIELD =
  'h-8 w-full rounded-md border border-[var(--ed-line-strong)] bg-card px-2.5 text-[13px] focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11 max-sm:text-base';

/** One record line: picture, name, identifiers, size or edition, charter, rack,
 *  on hand (core's line, the same on the phone; "No charter" only for a record
 *  with none, recheck R2-6). */
function RecordLine({ r, view }: { r: GroupingReviewRecord; view: 'items' | 'books' }) {
  const detail = groupingRecordLine(r, view);
  return (
    <span className="flex min-w-0 items-start gap-2">
      {r.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed thumbnail in a dialog
        <img
          src={r.imageUrl}
          alt=""
          width={28}
          height={28}
          className="border-border h-7 w-7 shrink-0 rounded-[5px] border bg-white object-cover"
        />
      ) : (
        <MissingPhoto className="border-border h-7 w-7 shrink-0 rounded-[5px] border" />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{r.name}</span>
        <span className="text-muted-foreground block text-xs">{detail}</span>
      </span>
    </span>
  );
}

interface GroupSelectedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected records (distinct item ids: two rack rows of one record are one). */
  itemIds: readonly string[];
  view: 'items' | 'books';
  /** Open on "Add to an existing group" with this group chosen ("Add to group"). */
  initialGroupId?: string | null;
  /** Add these readable same-SKU records to the selection (the dialog then
   *  reviews the larger selection). Absent: no button. */
  onAddToSelection?: (ids: string[]) => void;
  /** Called once after a grouping applied or answered no-op. */
  onDone: (outcome: GroupingOutcome) => void;
  /** B5: the address of the list page that draws a group's header. Given
   *  only by a list paged on the server, which cannot tell which page that is
   *  (a list holding every record turns to the page itself): the done message
   *  then links to it ("Show it"), and following the link closes the dialog. */
  showGroupHref?: (groupId: string) => string;
}

export function GroupSelectedDialog({
  open,
  onOpenChange,
  itemIds,
  view,
  initialGroupId = null,
  onAddToSelection,
  onDone,
  showGroupHref,
}: GroupSelectedDialogProps) {
  const [mode, setMode] = React.useState<'new' | 'existing'>(initialGroupId ? 'existing' : 'new');
  const [name, setName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [groupId, setGroupId] = React.useState<string | null>(initialGroupId);
  // Each choice with the group it was made for (R2-1), never a bare id set.
  const [choices, setChoices] = React.useState<ReadonlyMap<string, GroupRecordChoice>>(
    () => new Map(),
  );
  const [ackFamily, setAckFamily] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'done'>('ready');
  const [outcome, setOutcome] = React.useState<GroupingOutcome | null>(null);
  const [error, setError] = React.useState<{ message: string; stale: boolean } | null>(null);
  const doneRef = React.useRef<HTMLButtonElement>(null);
  const keyed = useKeyedSave();
  // P11: a disabled Save is described by the reason it is off.
  const blockedId = React.useId();
  // R2-4: so is a disabled "Add them to the selection".
  const siblingsBlockedId = React.useId();

  /** One record's choice when it is in another group (P10): move it here, or
   *  leave it out (not sent; it stays where it is). Kept with the group the
   *  record is in as the person chooses (R2-1). */
  function choose(id: string, choice: 'move' | 'leave', fromGroupId: string) {
    setChoices((cur) => new Map(cur).set(id, { choice, fromGroupId }));
  }

  const targetGroupId = mode === 'existing' ? groupId : null;
  const {
    review,
    identity,
    error: previewError,
    retry: previewRetry,
    loading,
  } = useGroupingReview(open, itemIds, targetGroupId, nonce);

  // R2-1: a review that arrives drops every choice made for a group its
  // record is no longer in (or a record no longer in the review), so the
  // radios come back empty and Save stays off until the person decides again;
  // a choice for a record still in that group holds. The render reads the
  // same rule (groupingDecisionsFor), so no frame shows or sends a dropped
  // choice before this runs.
  React.useEffect(() => {
    if (!review) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prune the choices once per new review (R2-1)
    setChoices((cur) => choicesForReview(cur, review.records));
  }, [review]);
  const decisions = React.useMemo(
    () => groupingDecisionsFor(choices, review?.records ?? [], ackFamily),
    [choices, review, ackFamily],
  );

  // The name: a suggestion from the records (an editable field, never a link
  // made on a name) until the person types one.
  const nameValue = nameTouched ? name : review ? suggestGroupName(review.records, view) : '';

  const target: GroupDialogTarget =
    mode === 'new' ? { kind: 'new', name: nameValue } : { kind: 'existing', groupId };
  const plan = React.useMemo(
    () =>
      review
        ? planGrouping(itemIds, { ...review, records: review.records }, target, decisions)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from mode/nameValue/groupId
    [review, itemIds, mode, nameValue, groupId, decisions],
  );

  React.useEffect(() => {
    if (phase === 'done') doneRef.current?.focus();
  }, [phase]);

  async function save() {
    if (!plan || !identity) return;
    if (plan.noop) {
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
      return;
    }
    if (!plan.canSave) return;
    const body = keyed.bodyFor(
      groupBodyForPlan(plan, target, decisions, {
        idempotencyKey: 'pending',
        ...identity,
      }),
    );
    setError(null);
    setPhase('saving');
    const r = await sendGrouping(body);
    if (!r.ok) {
      setError({ message: r.message, stale: r.stale });
      setPhase('ready');
      return;
    }
    keyed.reset();
    setOutcome(r.outcome);
    setPhase('done');
    onDone(r.outcome);
  }

  // The plan holds the preview's records; the review's carry the names,
  // rack line and picture too.
  const reviewById = new Map((review?.records ?? []).map((r) => [r.id, r]));
  const records = (plan?.records ?? []).flatMap((r) => {
    const full = reviewById.get(r.id);
    return full ? [full] : [];
  });
  const leftOutReason = new Map((plan?.leftOut ?? []).map((l) => [l.id, l.reason]));
  // A record in another group than the target: its row asks to move it here
  // or leave it out (P10).
  const otherGroupOf = (r: GroupingReviewRecord) =>
    r.displayGroup && r.displayGroup.id !== targetGroupId ? r.displayGroup : null;
  // The rows that carry those two radios, in the order listed, and each
  // radio's name: its record's, told apart from the other records here with
  // the same name by the words of their lines (redesign Stage 6).
  const withChoice = records.filter((r) => {
    const reason = leftOutReason.get(r.id);
    return (!reason || reason === 'chosen') && otherGroupOf(r) !== null;
  });
  const choiceNames = new Map(
    withChoice.map((r) => [r.id, groupChoiceRadioNames(r, withChoice, view)]),
  );
  const siblings = plan?.conflicts.sameSkuSiblings ?? [];
  const editions = plan?.conflicts.editions ?? null;
  const showEditions = editions !== null && (editions.editions > 1 || editions.unknown > 0);
  const candidates = review?.candidateGroups ?? [];
  const sendCount = plan?.send.length ?? 0;
  // Save counts the records that JOIN an existing group, never those already
  // in it (P6).
  const joinCount = plan?.joining.length ?? 0;
  const targetName =
    mode === 'existing'
      ? (review?.targetGroup?.name ?? candidates.find((c) => c.id === groupId)?.name ?? '')
      : (normalizeGroupName(nameValue) ?? '');
  const targetMembers = mode === 'existing' ? (plan?.targetMembers ?? []) : [];

  return (
    <Dialog open={open} onOpenChange={(v) => (phase === 'saving' ? null : onOpenChange(v))}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{GROUP_COPY.title(itemIds.length)}</DialogTitle>
          <DialogDescription>{GROUP_COPY.intro}</DialogDescription>
        </DialogHeader>

        {phase === 'done' && outcome ? (
          <div role="status" className="space-y-2 text-sm">
            <p className="font-medium">
              {outcome.outcome === 'noop'
                ? GROUP_COPY.noop(outcome.group?.name ?? '')
                : GROUP_COPY.done(outcome.group?.name ?? '')}
              {outcome.group && showGroupHref ? (
                <>
                  {' '}
                  <Link
                    href={showGroupHref(outcome.group.id)}
                    prefetch={false}
                    aria-label={GROUP_COPY.showItFor(outcome.group.name)}
                    className="underline underline-offset-2"
                    onClick={() => onOpenChange(false)}
                  >
                    {GROUP_COPY.showIt}
                  </Link>
                </>
              ) : null}
            </p>
            <p className="text-muted-foreground text-xs">{GROUP_COPY.skuNote}</p>
          </div>
        ) : loading ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the records…
          </div>
        ) : previewError ? null : (
          <div className="space-y-4 text-sm">
            <ul className="space-y-2" aria-label="Selected records">
              {records.map((r) => {
                const reason = leftOutReason.get(r.id);
                const other = otherGroupOf(r);
                const names = choiceNames.get(r.id);
                const inTarget = !!targetGroupId && r.displayGroup?.id === targetGroupId;
                return (
                  <li
                    key={r.id}
                    data-testid={`group-row-${r.id}`}
                    className="border-border space-y-1 rounded-md border p-2"
                  >
                    <RecordLine r={r} view={view} />
                    {reason && reason !== 'chosen' ? (
                      <p className="text-muted-foreground text-xs">
                        Left out: {r.name} {GROUP_COPY.leftOutReason[reason]}.
                      </p>
                    ) : null}
                    {!reason && inTarget ? (
                      <p className="text-muted-foreground text-xs">{GROUP_COPY.alreadyInTarget}</p>
                    ) : null}
                    {names && other ? (
                      // One explicit choice per record (P10): move it here,
                      // or leave it out (not sent; it stays in its group).
                      // Each radio names its record, so two records in one
                      // group are told apart by a screen reader (R2-5), and
                      // two records with one name by the words of their
                      // lines (redesign Stage 6).
                      <fieldset className="space-y-1 text-xs">
                        <legend>{GROUP_COPY.otherGroup(other.name)}</legend>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`group-choice-${r.id}`}
                            checked={decisions.moveIds.has(r.id)}
                            disabled={phase === 'saving'}
                            onChange={() => choose(r.id, 'move', other.id)}
                            aria-label={names.move}
                          />
                          <span>{GROUP_COPY.moveOne}</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`group-choice-${r.id}`}
                            checked={decisions.leaveOutIds.has(r.id)}
                            disabled={phase === 'saving'}
                            onChange={() => choose(r.id, 'leave', other.id)}
                            aria-label={names.leave}
                          />
                          <span>{GROUP_COPY.leaveOutOne}</span>
                        </label>
                      </fieldset>
                    ) : null}
                    {!reason && r.productGroupId && !inTarget ? (
                      <p className="text-muted-foreground text-xs">
                        {GROUP_COPY.family(r.productGroupName)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {plan && plan.unavailableCount > 0 ? (
              <p className="text-muted-foreground text-xs">
                {GROUP_COPY.unavailable(plan.unavailableCount)}
              </p>
            ) : null}

            {(plan?.conflicts.family.length ?? 0) > 0 ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={ackFamily}
                  disabled={phase === 'saving'}
                  onChange={(e) => setAckFamily(e.target.checked)}
                />
                <span>{GROUP_COPY.acknowledgeFamily}</span>
              </label>
            ) : null}

            {siblings.length > 0 ? (
              <div className="space-y-1 text-xs">
                {[...new Set(siblings.map((s) => s.sku))].map((sku) => (
                  <p key={sku} className="text-muted-foreground">
                    {GROUP_COPY.sameSku(siblings.filter((s) => s.sku === sku).length, sku)}
                  </p>
                ))}
                {onAddToSelection ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      // One request reviews at most 100 records: past that the
                      // review could only fail, so the button is off and says
                      // why (recheck R2-4).
                      disabled={phase === 'saving' || !!plan?.addSiblingsBlockedReason}
                      aria-describedby={
                        plan?.addSiblingsBlockedReason ? siblingsBlockedId : undefined
                      }
                      onClick={() => {
                        if (plan?.addSiblingsBlockedReason) return;
                        onAddToSelection(siblings.map((s) => s.id));
                      }}
                    >
                      {GROUP_COPY.addSiblings}
                    </Button>
                    {plan?.addSiblingsBlockedReason ? (
                      <p id={siblingsBlockedId} className="text-muted-foreground">
                        {plan.addSiblingsBlockedReason}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {showEditions && editions ? (
              <p className="text-muted-foreground text-xs">
                {editions.unknown > 0
                  ? GROUP_COPY.editionsUnknown
                  : GROUP_COPY.editions(editions.editions)}
              </p>
            ) : null}

            <fieldset className="border-border space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium">Where they go</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="group-target"
                  checked={mode === 'new'}
                  disabled={phase === 'saving'}
                  onChange={() => setMode('new')}
                />
                <span>{GROUP_COPY.targetNew}</span>
              </label>
              {mode === 'new' ? (
                <label className="block space-y-1 pl-6">
                  <span className="text-xs">{GROUP_COPY.nameLabel}</span>
                  <input
                    className={FIELD}
                    value={nameValue}
                    maxLength={120}
                    disabled={phase === 'saving'}
                    onChange={(e) => {
                      setNameTouched(true);
                      setName(e.target.value);
                    }}
                  />
                </label>
              ) : null}
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="group-target"
                  checked={mode === 'existing'}
                  disabled={phase === 'saving'}
                  onChange={() => setMode('existing')}
                />
                <span>{GROUP_COPY.targetExisting}</span>
              </label>
              {mode === 'existing' ? (
                <label className="block space-y-1 pl-6">
                  <span className="text-xs">{GROUP_COPY.existingLabel}</span>
                  {candidates.length === 0 && !groupId ? (
                    <span className="text-muted-foreground block text-xs">
                      {GROUP_COPY.noCandidates}
                    </span>
                  ) : (
                    <select
                      className={FIELD}
                      value={groupId ?? ''}
                      disabled={phase === 'saving'}
                      onChange={(e) => setGroupId(e.target.value || null)}
                    >
                      <option value="">Choose a group</option>
                      {candidates.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({GROUP_COPY.headerRecords(g.memberCount)})
                        </option>
                      ))}
                      {groupId &&
                      !candidates.some((g) => g.id === groupId) &&
                      review?.targetGroup ? (
                        <option value={groupId}>{review.targetGroup.name}</option>
                      ) : null}
                    </select>
                  )}
                </label>
              ) : null}
            </fieldset>

            {plan?.previewHeader ? (
              <div className="space-y-1">
                <p className="text-xs font-medium">{GROUP_COPY.previewLabel}</p>
                <p
                  className="bg-sunk rounded-md px-2 py-1 font-medium"
                  data-testid="group-preview-header"
                >
                  {plan.previewHeader}
                </p>
                {targetMembers.length > 0 ? (
                  // The group's other records the person can see (P8).
                  <div className="space-y-0.5 pt-1 text-xs">
                    <p className="font-medium">{GROUP_COPY.targetMembers(targetName)}</p>
                    <ul
                      className="text-muted-foreground space-y-0.5"
                      aria-label={GROUP_COPY.targetMembers(targetName)}
                    >
                      {targetMembers.slice(0, TARGET_MEMBERS_SHOWN).map((m) => (
                        <li key={m.id}>
                          {[m.name, m.sku ? `SKU ${m.sku}` : null, `${m.quantityOnHand} on hand`]
                            .filter(Boolean)
                            .join(' · ')}
                        </li>
                      ))}
                    </ul>
                    {targetMembers.length > TARGET_MEMBERS_SHOWN ? (
                      <p className="text-muted-foreground">
                        {GROUP_COPY.moreTargetMembers(targetMembers.length - TARGET_MEMBERS_SHOWN)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <p className="text-muted-foreground text-xs">{GROUP_COPY.skuNote}</p>
            {plan?.noop ? (
              <p role="status" className="text-xs">
                {GROUP_COPY.noop(plan.noop.name)}
              </p>
            ) : plan?.blockedReason ? (
              <p
                id={blockedId}
                className="text-muted-foreground text-xs"
                data-testid="group-blocked"
                aria-live="polite"
              >
                {plan.blockedReason}
              </p>
            ) : null}
          </div>
        )}

        {previewError || error ? (
          <p role="alert" className="text-destructive text-sm">
            {previewError ?? error?.message}
          </p>
        ) : null}

        <DialogFooter>
          {phase === 'done' ? (
            <Button ref={doneRef} onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={phase === 'saving'}
                onClick={() => onOpenChange(false)}
              >
                {GROUP_COPY.cancel}
              </Button>
              {error?.stale ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    keyed.reset();
                    setError(null);
                    setNonce((n) => n + 1);
                  }}
                >
                  Review again
                </Button>
              ) : null}
              {previewError && previewRetry ? (
                // A failed review that a second look may answer differently
                // (recheck R2-2): read it again.
                <Button variant="outline" onClick={() => setNonce((n) => n + 1)}>
                  Try again
                </Button>
              ) : null}
              {!loading && !previewError && !error?.stale && plan ? (
                <Button
                  onClick={() => void save()}
                  disabled={phase === 'saving' || !identity || (!plan.noop && !plan.canSave)}
                  aria-describedby={!plan.noop && plan.blockedReason ? blockedId : undefined}
                >
                  {phase === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {plan.noop
                    ? GROUP_COPY.noopConfirm
                    : mode === 'existing' && targetName
                      ? GROUP_COPY.confirmExisting(joinCount, targetName)
                      : GROUP_COPY.confirmNew(sendCount)}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RemoveFromGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The records to take out of their group (distinct item ids). */
  itemIds: readonly string[];
  view: 'items' | 'books';
  onDone: (outcome: GroupingOutcome) => void;
}

/** Remove from group: deletes only the memberships. Records, SKUs, stock,
 *  charters and racks stay exactly as they are. It names every selected
 *  record it leaves out and why, counts the unavailable ones, and says when a
 *  group loses its last records the person can see, or how many stay (people
 *  review P9). One request takes at most 100 records: with more on screen
 *  it reviews the first 100 and says so (data review D3). */
export function RemoveFromGroupDialog({
  open,
  onOpenChange,
  itemIds,
  view,
  onDone,
}: RemoveFromGroupDialogProps) {
  const [nonce, setNonce] = React.useState(0);
  const capped = itemIds.length > GROUPING_MAX_ITEMS;
  const reviewIds = capped ? itemIds.slice(0, GROUPING_MAX_ITEMS) : itemIds;
  const {
    review,
    identity,
    error: previewError,
    retry: previewRetry,
    loading,
  } = useGroupingReview(open, reviewIds, null, nonce);
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'done'>('ready');
  const [error, setError] = React.useState<{ message: string; stale: boolean } | null>(null);
  const [outcome, setOutcome] = React.useState<GroupingOutcome | null>(null);
  const doneRef = React.useRef<HTMLButtonElement>(null);
  const keyed = useKeyedSave();
  const plan = review ? planRemoval(reviewIds, review) : null;
  // The plan holds the preview's records; the review's carry the names, rack
  // line and picture too.
  const reviewById = new Map((review?.records ?? []).map((r) => [r.id, r]));
  const grouped = (plan?.remove ?? []).flatMap((r) => {
    const full = reviewById.get(r.id);
    return full ? [full] : [];
  });

  React.useEffect(() => {
    if (phase === 'done') doneRef.current?.focus();
  }, [phase]);

  async function save() {
    if (!identity || grouped.length === 0) return;
    const body = keyed.bodyFor(
      removeBodyFor(
        grouped.map((r) => ({ id: r.id, displayGroupId: r.displayGroup!.id })),
        { idempotencyKey: 'pending', ...identity },
      ),
    );
    setError(null);
    setPhase('saving');
    const r = await sendGrouping(body);
    if (!r.ok) {
      setError({ message: r.message, stale: r.stale });
      setPhase('ready');
      return;
    }
    keyed.reset();
    setOutcome(r.outcome);
    setPhase('done');
    onDone(r.outcome);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (phase === 'saving' ? null : onOpenChange(v))}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{GROUP_COPY.removeTitle(grouped.length || reviewIds.length)}</DialogTitle>
          <DialogDescription>{GROUP_COPY.removeIntro}</DialogDescription>
        </DialogHeader>
        {phase === 'done' && outcome ? (
          <p role="status" className="text-sm font-medium">
            {GROUP_COPY.removeDone(outcome.changes.length)}
          </p>
        ) : loading ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the records…
          </div>
        ) : previewError ? null : (
          <div className="space-y-3 text-sm">
            {capped ? <p className="text-xs">{GROUP_COPY.removeCapped(itemIds.length)}</p> : null}
            <ul className="space-y-2" aria-label="Records to remove from their group">
              {grouped.map((r) => (
                <li key={r.id} className="space-y-0.5">
                  <RecordLine r={r} view={view} />
                  <p className="text-muted-foreground pl-9 text-xs">
                    {GROUP_COPY.itemPageInGroup(r.displayGroup!.name)}
                  </p>
                </li>
              ))}
              {grouped.length === 0 ? (
                <li className="text-muted-foreground text-xs">
                  None of these records is in a group you can change.
                </li>
              ) : null}
            </ul>
            {(plan?.leftOut ?? []).map((l) => (
              <p key={l.id} className="text-muted-foreground text-xs">
                Left out: {reviewById.get(l.id)?.name ?? ''}{' '}
                {GROUP_COPY.removeLeftOutReason[l.reason]}.
              </p>
            ))}
            {plan && plan.unavailableCount > 0 ? (
              <p className="text-muted-foreground text-xs">
                {GROUP_COPY.unavailable(plan.unavailableCount)}
              </p>
            ) : null}
            {(plan?.groups ?? []).map((g) =>
              g.staying === null ? null : (
                <p key={g.id} className="text-xs">
                  {g.staying === 0
                    ? GROUP_COPY.removeLast(g.name)
                    : GROUP_COPY.removeStays(g.staying, g.name)}
                </p>
              ),
            )}
          </div>
        )}
        {previewError || error ? (
          <p role="alert" className="text-destructive text-sm">
            {previewError ?? error?.message}
          </p>
        ) : null}
        <DialogFooter>
          {phase === 'done' ? (
            <Button ref={doneRef} onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={phase === 'saving'}
                onClick={() => onOpenChange(false)}
              >
                {GROUP_COPY.cancel}
              </Button>
              {error?.stale ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    keyed.reset();
                    setError(null);
                    setNonce((n) => n + 1);
                  }}
                >
                  Review again
                </Button>
              ) : null}
              {previewError && previewRetry ? (
                // A failed review that a second look may answer differently
                // (recheck R2-2): read it again.
                <Button variant="outline" onClick={() => setNonce((n) => n + 1)}>
                  Try again
                </Button>
              ) : null}
              {!loading && !previewError && !error?.stale && grouped.length > 0 ? (
                <Button onClick={() => void save()} disabled={phase === 'saving' || !identity}>
                  {phase === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {GROUP_COPY.removeConfirm(grouped.length)}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  /** Records of the group on screen (to read the group and its version). */
  memberIds: readonly string[];
  onDone: (outcome: GroupingOutcome) => void;
}

/** Rename a group: only its name changes. */
export function RenameGroupDialog({
  open,
  onOpenChange,
  groupId,
  memberIds,
  onDone,
}: RenameGroupDialogProps) {
  const [nonce, setNonce] = React.useState(0);
  // The group is read through ONE of its records on screen (any readable
  // member names it): a group can hold 200 records and one request reads at
  // most 100 (data review D3).
  const {
    review,
    identity,
    error: previewError,
    retry: previewRetry,
    loading,
  } = useGroupingReview(open, memberIds.slice(0, 1), groupId, nonce);
  const [name, setName] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'done'>('ready');
  const [error, setError] = React.useState<{ message: string; stale: boolean } | null>(null);
  const keyed = useKeyedSave();
  const current = review?.targetGroup ?? null;
  const value = name ?? current?.name ?? '';
  const normalized = normalizeGroupName(value);

  async function save() {
    if (!identity || !current || !normalized) return;
    const body = keyed.bodyFor({
      action: 'rename',
      idempotencyKey: 'pending',
      ...identity,
      groupId,
      expectedVersion: current.version,
      name: normalized,
    });
    setError(null);
    setPhase('saving');
    const r = await sendGrouping(body);
    if (!r.ok) {
      setError({ message: r.message, stale: r.stale });
      setPhase('ready');
      return;
    }
    keyed.reset();
    setPhase('done');
    onDone(r.outcome);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (phase === 'saving' ? null : onOpenChange(v))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{GROUP_COPY.renameAction}</DialogTitle>
          <DialogDescription>
            Only the group&apos;s name changes. Its records stay as they are.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the group…
          </div>
        ) : previewError ? null : !current ? (
          // The review found no such group: it closed or is not readable any
          // more (recheck R2-2). Said like any refusal; Save stays off.
          <p role="alert" className="text-destructive text-sm">
            {GROUPING_ERROR_WORDS.groupNotFound}
          </p>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="text-xs">{GROUP_COPY.nameLabel}</span>
            <input
              className={FIELD}
              value={value}
              maxLength={120}
              disabled={phase === 'saving'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {previewError || error ? (
          <p role="alert" className="text-destructive text-sm">
            {previewError ?? error?.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={phase === 'saving'}
            onClick={() => onOpenChange(false)}
          >
            {GROUP_COPY.cancel}
          </Button>
          {error?.stale ? (
            <Button
              variant="outline"
              onClick={() => {
                keyed.reset();
                setError(null);
                setName(null);
                setNonce((n) => n + 1);
              }}
            >
              Review again
            </Button>
          ) : previewError && previewRetry ? (
            // A failed review that a second look may answer differently (R2-2).
            <Button variant="outline" onClick={() => setNonce((n) => n + 1)}>
              Try again
            </Button>
          ) : (
            <Button
              onClick={() => void save()}
              disabled={phase === 'saving' || !identity || !current || !normalized}
            >
              {phase === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save name
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
