'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  familyStaysListedByName,
  familyStaysListedByNameAfter,
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  groupingPreviewKey,
  groupingRecordLine,
  keyedUngroupSelectedBody,
  planUngroupSelected,
  randomRequestUuid,
  ungroupAnchorFor,
  ungroupChangeCount,
  ungroupListMayBeStale,
  UNGROUP_COPY,
  ungroupOutcomeWords,
  ungroupRecordOutcome,
  ungroupResultLines,
  ungroupSelectedBodyForPlan,
  type UngroupKind,
  type UngroupSelectedBody,
  type UngroupSelectedOutcome,
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
import { labelsItemsHref } from '@/lib/inventory/labels-selection';
import {
  previewUngroupSelectedAction,
  ungroupSelectedAction,
} from '@/server/actions/item-grouping';
import type { GroupingReviewRecord, UngroupCandidate } from '@/server/services/item-grouping';
import type { UngroupSelectedReview } from '@/server/services/ungroup-selected';

/**
 * Ungroup for ANY ticked records (owner 2026-10-12, Ungroup anything): the
 * Items and Books bulk bar's one review dialog. Each ticked record the viewer
 * can read is listed with its line (core groupingRecordLine: SKU, a book's
 * ISBN, size, charter, rack, warehouse, on hand) and what happens to it, by
 * the grouping it is SHOWN under on the list (core planUngroupSelected):
 *   "Gets its own SKU" (or "Keeps SKU X" for the record that keeps a fully
 *   ticked SKU, chosen with a radio, the oldest by default);
 *   "Leaves group <name>";
 *   "Leaves the <family> size family", with the Returns exchange note;
 * and every record left out, with the reason (a kit, nothing to ungroup, a
 * record the viewer cannot edit, a family without permission). Save counts
 * the records that change, never the one that keeps a SKU, and the result
 * counts the same records.
 *
 * Save sends one body (core UngroupSelectedBody); the server runs it as
 * remove, split, unlink, each over the existing write, and answers per step.
 * When a step is refused after an earlier one applied, the result says what
 * applied and what was not done or not tried: nothing is half-applied
 * silently. The keyed steps carry keys minted at the first Save of a body
 * and kept for its retries (busy, a lost answer), so the database replays
 * instead of applying twice; a new review mints new ones. Cancel writes
 * nothing. A review that gets no answer, or one a second look may answer
 * differently, says so in core's words and offers Try again (recheck R2-2).
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every ticked record (distinct item ids). */
  itemIds: readonly string[];
  view: 'items' | 'books';
  /** The grouping each record was shown under on the list when the dialog
   *  opened (core shownUnderByRecord). */
  shownUnder?: ReadonlyMap<string, UngroupKind>;
  /** Called once after a Save changed any record (refresh the list). */
  onDone: (outcome: UngroupSelectedOutcome) => void;
}

type Loaded = UngroupSelectedReview & { organizationId: string; actorUserId: string };

/** Send the same body again only for these refusals. */
const RETRY_SAME = new Set(['busy', 'rate_limited', 'sku_generation_failed']);

function previewMayRetry(error: { code: string; details?: Record<string, unknown> }): boolean {
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : error.code;
  return error.code === 'internal_error' || error.code === 'rate_limited' || reason === 'busy';
}

function failureWords(): string {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? UNGROUP_COPY.selectedOffline
    : GROUPING_ERROR_WORDS.internal;
}

function RecordLine({ r, view }: { r: GroupingReviewRecord; view: 'items' | 'books' }) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      {r.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed thumbnail in a dialog
        <img
          src={r.imageUrl}
          alt=""
          width={28}
          height={28}
          className="border-border h-7 w-7 shrink-0 rounded-[5px] border object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="border-border bg-muted h-7 w-7 shrink-0 rounded-[5px] border"
        />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{r.name}</span>
        <span className="text-muted-foreground block text-xs">{groupingRecordLine(r, view)}</span>
      </span>
    </span>
  );
}

export function UngroupSelectedDialog({
  open,
  onOpenChange,
  itemIds,
  view,
  shownUnder,
  onDone,
}: Props) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [previewError, setPreviewError] = React.useState<{
    message: string;
    retry: boolean;
  } | null>(null);
  const [phase, setPhase] = React.useState<'ready' | 'saving' | 'result'>('ready');
  const [saveError, setSaveError] = React.useState<{ message: string; stale: boolean } | null>(
    null,
  );
  const [outcome, setOutcome] = React.useState<UngroupSelectedOutcome | null>(null);
  const [anchorBySku, setAnchorBySku] = React.useState<Record<string, string>>({});
  const [nonce, setNonce] = React.useState(0);
  const pending = React.useRef<{ json: string; body: UngroupSelectedBody } | null>(null);
  // The body a result's Try again sends unchanged (keys and all), when a step
  // was refused in a way the same Save may answer differently (busy).
  const [retryBody, setRetryBody] = React.useState<UngroupSelectedBody | null>(null);
  const seq = React.useRef(0);
  const doneRef = React.useRef<HTMLButtonElement>(null);
  const idsKey = itemIds.join(',');

  React.useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const ids = idsKey ? idsKey.split(',') : [];
    pending.current = null;
    /* eslint-disable react-hooks/set-state-in-effect -- reset on open / a new look */
    setLoading(true);
    setPreviewError(null);
    setSaveError(null);
    setOutcome(null);
    setRetryBody(null);
    setPhase('ready');
    setAnchorBySku({});
    /* eslint-enable react-hooks/set-state-in-effect */
    void previewUngroupSelectedAction(ids).then(
      (r) => {
        if (mine !== seq.current) return;
        if (!r.ok) {
          setLoaded(null);
          setPreviewError({
            message: r.error.message || GROUPING_ERROR_WORDS.internal,
            retry: previewMayRetry(r.error),
          });
          setLoading(false);
          return;
        }
        // An answer for another selection than this one is stale.
        if (r.data.previewKey !== groupingPreviewKey(r.data.organizationId, ids, null)) return;
        setLoaded(r.data);
        setLoading(false);
      },
      () => {
        if (mine !== seq.current) return;
        setLoaded(null);
        setPreviewError({ message: failureWords(), retry: true });
        setLoading(false);
      },
    );
  }, [open, idsKey, nonce]);

  const plan = React.useMemo(
    () =>
      loaded
        ? planUngroupSelected(idsKey ? idsKey.split(',') : [], loaded.review, loaded.candidates, {
            canUnlinkFamilies: loaded.canUnlinkFamilies,
            shownUnder,
          })
        : null,
    [loaded, idsKey, shownUnder],
  );
  const changing = plan ? ungroupChangeCount(plan, anchorBySku) : 0;
  const reviewById = new Map((loaded?.review.records ?? []).map((r) => [r.id, r]));
  const candidateById = new Map<string, UngroupCandidate>(
    (loaded?.candidates ?? []).map((c) => [c.id, c]),
  );

  React.useEffect(() => {
    if (phase === 'result') doneRef.current?.focus();
  }, [phase]);

  async function save() {
    if (!plan || !loaded || changing === 0) return;
    pending.current = keyedUngroupSelectedBody(
      pending.current,
      ungroupSelectedBodyForPlan(plan, anchorBySku, {
        organizationId: loaded.organizationId,
        actorUserId: loaded.actorUserId,
        removeKey: 'pending',
        splitKey: 'pending',
      }),
      randomRequestUuid,
    );
    await send(pending.current.body);
  }

  async function send(body: UngroupSelectedBody) {
    setSaveError(null);
    setPhase('saving');
    let r: Awaited<ReturnType<typeof ungroupSelectedAction>>;
    try {
      r = await ungroupSelectedAction(body);
    } catch {
      // No answer: it may or may not have applied. The SAME body and keys
      // stay pending, so Save replays what applied. Never the raw error.
      setSaveError({ message: GROUPING_ERROR_WORDS.internal, stale: false });
      setPhase('ready');
      return;
    }
    if (!r.ok) {
      // Refused before anything was written.
      const reason =
        typeof r.error.details?.reason === 'string' ? r.error.details.reason : r.error.code;
      const stale = !RETRY_SAME.has(reason);
      if (stale) pending.current = null;
      setSaveError({ message: r.error.message || GROUPING_ERROR_WORDS.internal, stale });
      setPhase('ready');
      return;
    }
    const o = r.data.outcome;
    // Keep the body (and its keys) only when the same Save may help again.
    const again = !o.complete && o.parts.some((p) => p.retryable);
    if (!again) pending.current = null;
    setRetryBody(again ? body : null);
    setOutcome(o);
    setPhase('result');
    if (ungroupListMayBeStale(o)) onDone(o);
  }

  function reviewAgain() {
    pending.current = null;
    setNonce((n) => n + 1);
  }

  const busy = phase === 'saving';
  const lines = outcome ? ungroupResultLines(outcome) : null;
  const splitPart = outcome?.parts.find((p) => p.kind === 'split');
  const splitChanged = (splitPart?.splitItems ?? []).filter((i) => !i.kept);
  // Kept although the review showed "Gets its own SKU": the other records of
  // its SKU changed meanwhile (the database keeps the oldest).
  const keptUnplanned = (splitPart?.splitItems ?? []).filter(
    (i) =>
      i.kept && !(plan?.split.groups ?? []).some((g) => ungroupAnchorFor(g, anchorBySku) === i.id),
  );
  const relabel = splitChanged
    .filter((i) => !(candidateById.get(i.id)?.barcode ?? '').trim())
    .map((i) => i.id);
  const relabelPlanned = (plan?.split.groups ?? []).some((g) => {
    const anchor = ungroupAnchorFor(g, anchorBySku);
    return g.selected.some(
      (c) => c.id !== anchor && !(candidateById.get(c.id)?.barcode ?? '').trim(),
    );
  });
  const firstOfSku = new Set(
    (plan?.split.groups ?? []).filter((g) => g.allSelected).map((g) => g.selected[0]?.id),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? null : onOpenChange(v))}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{UNGROUP_COPY.selectedTitle}</DialogTitle>
          <DialogDescription>{UNGROUP_COPY.selectedIntro}</DialogDescription>
        </DialogHeader>

        {phase === 'result' && outcome && lines ? (
          <div className="space-y-3 text-sm">
            <div role="status" className="space-y-1.5">
              {lines.done.map((l) => (
                <p key={l} className="font-medium">
                  {l}
                </p>
              ))}
              {splitChanged.length > 0 ? (
                <ul className="space-y-1">
                  {splitChanged.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span>{reviewById.get(i.id)?.name ?? 'Record'}</span>
                      <span className="text-muted-foreground font-mono text-xs line-through">
                        {i.beforeSku}
                      </span>
                      <span className="font-mono text-xs">{i.afterSku}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {keptUnplanned.map((i) => (
                <p key={i.id} className="text-muted-foreground text-xs">
                  {reviewById.get(i.id)?.name ?? 'Record'}: {UNGROUP_COPY.keptUnplanned(i.afterSku)}
                </p>
              ))}
              {relabel.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {UNGROUP_COPY.labelsHint}{' '}
                  <Link className="text-foreground underline" href={labelsItemsHref(relabel)}>
                    Print labels
                  </Link>
                </p>
              ) : null}
              {familyStaysListedByNameAfter(outcome, (x) => reviewById.get(x)?.name, view) ? (
                <p className="text-xs">{UNGROUP_COPY.familyNameNote}</p>
              ) : null}
            </div>
            {lines.notDone.length > 0 ? (
              <div role="alert" className="text-destructive space-y-1 text-sm">
                {lines.notDone.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </div>
            ) : null}
          </div>
        ) : loading ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the records…
          </div>
        ) : previewError || !plan ? null : (
          <div className="space-y-3 text-sm">
            <ul className="space-y-2.5" aria-label="What happens to each selected record">
              {plan.records.map((rec) => {
                const r = reviewById.get(rec.id);
                const o = ungroupRecordOutcome(plan, rec.id, anchorBySku);
                if (!r || !o) return null;
                const group =
                  o.kind === 'split'
                    ? plan.split.groups.find((g) => g.selected.some((c) => c.id === rec.id))
                    : undefined;
                const choose = !!group?.allSelected;
                return (
                  <li
                    key={rec.id}
                    data-testid={`ungroup-selected-row-${rec.id}`}
                    className="space-y-1"
                  >
                    {choose && group && firstOfSku.has(rec.id) ? (
                      <p className="text-muted-foreground text-xs">
                        SKU {group.sku}: {UNGROUP_COPY.anchorLegend}
                      </p>
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex min-w-0 items-start gap-2">
                        {choose && group ? (
                          <input
                            type="radio"
                            name={`ungroup-selected-anchor-${group.sku}`}
                            className="mt-2"
                            aria-label={`${UNGROUP_COPY.keepsSku(group.sku)}: ${r.name}`}
                            aria-describedby={`ungroup-selected-outcome-${rec.id}`}
                            checked={ungroupAnchorFor(group, anchorBySku) === rec.id}
                            disabled={busy}
                            onChange={() => setAnchorBySku((m) => ({ ...m, [group.sku]: rec.id }))}
                          />
                        ) : null}
                        <RecordLine r={r} view={view} />
                      </span>
                      <span
                        id={`ungroup-selected-outcome-${rec.id}`}
                        className={
                          o.kind === 'left_out'
                            ? 'text-muted-foreground max-w-[45%] shrink-0 text-right text-xs'
                            : 'max-w-[45%] shrink-0 text-right text-xs font-medium'
                        }
                      >
                        {ungroupOutcomeWords(o)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {plan.unavailableCount > 0 ? (
              <p className="text-muted-foreground text-xs">
                {GROUP_COPY.unavailable(plan.unavailableCount)}
              </p>
            ) : null}
            {plan.split.groups
              .filter((g) => !g.allSelected)
              .map((g) => (
                <p key={g.sku} className="text-muted-foreground text-xs">
                  {UNGROUP_COPY.othersKeep(g.others.length, g.sku)}
                </p>
              ))}
            {plan.groups.map((g) =>
              g.staying === null ? null : (
                <p key={g.id} className="text-xs">
                  {g.staying === 0
                    ? GROUP_COPY.removeLast(g.name)
                    : GROUP_COPY.removeStays(g.staying, g.name)}
                </p>
              ),
            )}
            {plan.leaveFamily.length > 0 ? (
              <p className="text-xs">{UNGROUP_COPY.familyNote}</p>
            ) : null}
            {familyStaysListedByName(plan.leaveFamily, view) ? (
              <p className="text-xs">{UNGROUP_COPY.familyNameNote}</p>
            ) : null}
            {plan.split.splitIds.length > 0 ? (
              <p className="text-muted-foreground text-xs">{UNGROUP_COPY.barcodeNote}</p>
            ) : null}
            {relabelPlanned ? (
              <p className="text-muted-foreground text-xs">{UNGROUP_COPY.labelsBefore}</p>
            ) : null}
            {changing === 0 ? (
              <p className="text-xs font-medium">{UNGROUP_COPY.selectedNothing}</p>
            ) : null}
          </div>
        )}

        {previewError || saveError ? (
          <p role="alert" className="text-destructive text-sm">
            {previewError?.message ?? saveError?.message}
          </p>
        ) : null}

        <DialogFooter>
          {phase === 'result' ? (
            <>
              {outcome && !outcome.complete ? (
                retryBody ? (
                  <Button variant="outline" onClick={() => void send(retryBody)}>
                    Try again
                  </Button>
                ) : (
                  <Button variant="outline" onClick={reviewAgain}>
                    Review again
                  </Button>
                )
              ) : null}
              <Button ref={doneRef} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                {GROUP_COPY.cancel}
              </Button>
              {saveError?.stale ? (
                <Button variant="outline" onClick={reviewAgain}>
                  Review again
                </Button>
              ) : null}
              {previewError?.retry ? (
                <Button variant="outline" onClick={() => setNonce((n) => n + 1)}>
                  Try again
                </Button>
              ) : null}
              {!loading && !previewError && !saveError?.stale && changing > 0 ? (
                <Button onClick={() => void save()} disabled={busy || !loaded}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {UNGROUP_COPY.confirm(changing)}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
