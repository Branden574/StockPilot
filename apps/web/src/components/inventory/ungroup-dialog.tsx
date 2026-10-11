'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  GROUPING_ERROR_WORDS,
  planSkuSplit,
  randomRequestUuid,
  splitSkuBodyForPlan,
  UNGROUP_COPY,
  type SplitSkuBody,
  type SplitSkuOutcomeItem,
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
import { previewUngroupAction, ungroupItemsAction } from '@/server/actions/item-grouping';
import type { UngroupCandidate } from '@/server/services/item-grouping';

/**
 * Ungroup's review dialog (design section 5), for the Items and Books bulk
 * bar and the item page's "Make this its own item".
 *
 * It reads a preview (every live record of the selected records' SKUs the
 * viewer can read, oldest first) and shows, per SKU, each selected record and
 * what happens to it: "Gets a new SKU", or, when every record of that SKU the
 * viewer can see is selected, a choice of the one that keeps it (the oldest by
 * default). Records the database would refuse are listed with the reason and
 * left out. Cancel sends nothing.
 *
 * THE KEY: minted at the first Save of a body and kept, with that body, for
 * every retry of it (a busy answer, a lost answer): the database replays the
 * first outcome instead of splitting twice. A different body (another anchor)
 * or a new preview ("Review again") mints a new one. The Save sends back the
 * organization and the account the preview answered for, so a Save from a tab
 * whose session moved since is refused instead of applied under it.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  /** `anchors`: the records the Save named to keep their SKU. */
  | { kind: 'done'; items: SplitSkuOutcomeItem[]; anchors: string[] };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected records (distinct item ids). */
  itemIds: readonly string[];
  /** Called once after a split applied (clear the selection, refresh). */
  onDone: (items: SplitSkuOutcomeItem[]) => void;
}

/** Retry the same body only for these refusals; anything else needs a new look. */
const RETRY_SAME = new Set(['busy', 'sku_generation_failed', 'rate_limited']);

export function UngroupDialog({ open, onOpenChange, itemIds, onDone }: Props) {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });
  const [candidates, setCandidates] = React.useState<UngroupCandidate[]>([]);
  const [identity, setIdentity] = React.useState<{
    organizationId: string;
    actorUserId: string;
  } | null>(null);
  const [anchorBySku, setAnchorBySku] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<{ message: string; stale: boolean } | null>(null);
  const [previewNonce, setPreviewNonce] = React.useState(0);
  // The body and key of the current Save, kept for its retries.
  const pending = React.useRef<{ json: string; body: SplitSkuBody } | null>(null);
  // Only the newest preview may paint (a re-preview can overtake an older one).
  const seq = React.useRef(0);
  // Done replaces the focused Save button: focus moves to it (fix round 1, P6).
  const doneRef = React.useRef<HTMLButtonElement>(null);
  const idsKey = itemIds.join(',');

  React.useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    pending.current = null;
    /* eslint-disable react-hooks/set-state-in-effect -- reset on open / re-preview */
    setPhase({ kind: 'loading' });
    setError(null);
    setAnchorBySku({});
    /* eslint-enable react-hooks/set-state-in-effect */
    void previewUngroupAction(idsKey ? idsKey.split(',') : []).then((r) => {
      if (mine !== seq.current) return;
      if (!r.ok) {
        setCandidates([]);
        setIdentity(null);
        setError({ message: r.error.message, stale: false });
        setPhase({ kind: 'ready' });
        return;
      }
      setCandidates(r.data.candidates);
      setIdentity({ organizationId: r.data.organizationId, actorUserId: r.data.actorUserId });
      setPhase({ kind: 'ready' });
    });
  }, [open, idsKey, previewNonce]);

  const plan = React.useMemo(
    () => planSkuSplit(idsKey ? idsKey.split(',') : [], candidates),
    [idsKey, candidates],
  );
  const byId = React.useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);
  const count = plan.splitIds.length;

  const anchorOf = (sku: string, fallback: string | null) => {
    const chosen = anchorBySku[sku];
    return chosen ?? fallback;
  };

  async function save() {
    if (!identity || count === 0) return;
    const draft = splitSkuBodyForPlan(plan, anchorBySku, {
      idempotencyKey: 'pending',
      organizationId: identity.organizationId,
      actorUserId: identity.actorUserId,
    });
    const json = JSON.stringify({ ...draft, idempotencyKey: undefined });
    if (!pending.current || pending.current.json !== json) {
      pending.current = { json, body: { ...draft, idempotencyKey: randomRequestUuid() } };
    }
    setError(null);
    setPhase({ kind: 'saving' });
    const body = pending.current.body;
    let r: Awaited<ReturnType<typeof ungroupItemsAction>>;
    try {
      r = await ungroupItemsAction(body);
    } catch {
      // No answer (the network, a deploy): the split may or may not have
      // applied. Back to the review with the SAME body and key pending, so
      // Save replays it if it did (fix round 1, D6). Never the raw error.
      setError({ message: GROUPING_ERROR_WORDS.internal, stale: false });
      setPhase({ kind: 'ready' });
      return;
    }
    if (!r.ok) {
      const reason =
        typeof r.error.details?.reason === 'string' ? r.error.details.reason : r.error.code;
      setError({
        message: r.error.message || GROUPING_ERROR_WORDS.internal,
        stale: !RETRY_SAME.has(reason),
      });
      setPhase({ kind: 'ready' });
      return;
    }
    pending.current = null;
    setPhase({ kind: 'done', items: r.data.items, anchors: body.anchorItemIds });
    onDone(r.data.items);
  }

  React.useEffect(() => {
    if (phase.kind === 'done') doneRef.current?.focus();
  }, [phase.kind]);

  const changed = phase.kind === 'done' ? phase.items.filter((i) => !i.kept) : [];
  // Kept although the review showed "Gets a new SKU" (fix round 1, D5).
  const keptUnplanned =
    phase.kind === 'done' ? phase.items.filter((i) => i.kept && !phase.anchors.includes(i.id)) : [];
  const relabel = changed.filter((i) => !(byId.get(i.id)?.barcode ?? '').trim()).map((i) => i.id);
  // Before Save: will a record without a barcode get a new SKU (fix round 1,
  // D2)? Its label prints the old SKU, so a scan finds the records keeping it.
  const relabelPlanned = plan.groups.some((g) => {
    const anchor = g.allSelected ? anchorOf(g.sku, g.defaultAnchorId) : null;
    return g.selected.some((r) => r.id !== anchor && !(r.barcode ?? '').trim());
  });

  return (
    <Dialog open={open} onOpenChange={(v) => (phase.kind === 'saving' ? null : onOpenChange(v))}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{UNGROUP_COPY.title}</DialogTitle>
          <DialogDescription>{UNGROUP_COPY.intro}</DialogDescription>
        </DialogHeader>

        {phase.kind === 'loading' ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the records…
          </div>
        ) : phase.kind === 'done' ? (
          <div role="status" className="space-y-3 text-sm">
            {changed.length > 0 ? (
              <p className="font-medium">{UNGROUP_COPY.done(changed.length)}</p>
            ) : null}
            <ul className="space-y-1.5">
              {changed.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span>{byId.get(i.id)?.name ?? 'Record'}</span>
                  <span className="text-muted-foreground font-mono text-xs line-through">
                    {i.beforeSku}
                  </span>
                  <span className="font-mono text-xs">{i.afterSku}</span>
                </li>
              ))}
            </ul>
            {keptUnplanned.length > 0 ? (
              <ul className="text-muted-foreground space-y-1 text-xs">
                {keptUnplanned.map((i) => (
                  <li key={i.id}>
                    {byId.get(i.id)?.name ?? 'Record'}: {UNGROUP_COPY.keptUnplanned(i.afterSku)}
                  </li>
                ))}
              </ul>
            ) : null}
            {relabel.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                {UNGROUP_COPY.labelsHint}{' '}
                <Link className="text-foreground underline" href={labelsItemsHref(relabel)}>
                  Print labels
                </Link>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {plan.groups.map((g) => {
              const anchor = g.allSelected ? anchorOf(g.sku, g.defaultAnchorId) : null;
              return (
                <fieldset key={g.sku} className="border-border space-y-2 rounded-md border p-3">
                  <legend className="px-1 font-mono text-xs">SKU {g.sku}</legend>
                  {g.allSelected ? (
                    <p className="text-muted-foreground text-xs">{UNGROUP_COPY.anchorLegend}</p>
                  ) : null}
                  <ul className="space-y-2">
                    {g.selected.map((r) => {
                      const keeps = anchor === r.id;
                      return (
                        <li
                          key={r.id}
                          data-testid={`ungroup-row-${r.id}`}
                          className="flex items-start justify-between gap-3"
                        >
                          <label className="flex min-w-0 items-start gap-2">
                            {g.allSelected ? (
                              <input
                                type="radio"
                                name={`ungroup-anchor-${g.sku}`}
                                className="mt-1"
                                aria-describedby={`ungroup-outcome-${r.id}`}
                                checked={keeps}
                                disabled={phase.kind === 'saving'}
                                onChange={() => setAnchorBySku((m) => ({ ...m, [g.sku]: r.id }))}
                              />
                            ) : null}
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{r.name}</span>
                              <span className="text-muted-foreground block text-xs">
                                {[
                                  r.charterName ?? 'No charter',
                                  r.placementLabel ?? 'No rack',
                                  r.warehouseName,
                                  `${r.quantityOnHand} on hand`,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                          </label>
                          <span id={`ungroup-outcome-${r.id}`} className="shrink-0 text-xs">
                            {keeps ? UNGROUP_COPY.keepsSku(g.sku) : UNGROUP_COPY.getsNewSku}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {!g.allSelected ? (
                    <p className="text-muted-foreground text-xs">
                      {UNGROUP_COPY.othersKeep(g.others.length, g.sku)}
                    </p>
                  ) : null}
                </fieldset>
              );
            })}

            {plan.leftOut.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium">Left out:</p>
                <ul className="text-muted-foreground space-y-0.5 text-xs">
                  {plan.leftOut.map((l) => (
                    <li key={l.id}>
                      {byId.get(l.id)?.name ?? 'A record'} {UNGROUP_COPY.leftOutReason[l.reason]}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {count > 0 ? (
              <p className="text-muted-foreground text-xs">{UNGROUP_COPY.barcodeNote}</p>
            ) : null}
            {count > 0 && relabelPlanned ? (
              <p className="text-muted-foreground text-xs">{UNGROUP_COPY.labelsBefore}</p>
            ) : null}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error.message}
          </p>
        ) : null}

        <DialogFooter>
          {phase.kind === 'done' ? (
            <Button ref={doneRef} onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={phase.kind === 'saving'}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              {error?.stale ? (
                <Button variant="outline" onClick={() => setPreviewNonce((n) => n + 1)}>
                  Review again
                </Button>
              ) : null}
              {count > 0 && phase.kind !== 'loading' && !error?.stale ? (
                <Button onClick={() => void save()} disabled={phase.kind === 'saving' || !identity}>
                  {phase.kind === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {UNGROUP_COPY.confirm(count)}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
