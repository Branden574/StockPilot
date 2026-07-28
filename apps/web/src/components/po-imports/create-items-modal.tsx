'use client';

import { AlertTriangle, Loader2, Plus, RotateCcw } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  BLOCKING_LINE_RESULTS,
  LINE_RESULT_LABELS,
  SIZE_SYSTEMS,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency, formatNumber } from '@/lib/utils';
import {
  createItemsFromPoLinesAction,
  findDuplicatesForPoLinesAction,
  resolvePoImportLineResultsAction,
} from '@/server/actions/po-imports';
// Import the TYPE from the service (not re-exported through the 'use server'
// actions file): Turbopack miscompiles a `export type { X }` re-export in a
// 'use server' module into a runtime value reference, which crashes the whole
// module on evaluation (ReferenceError: DuplicateCandidate is not defined).
import type { DuplicateCandidate } from '@/server/services/po-imports-lines';

import type { PoImportLineRow } from '@/server/services/po-imports';
import type { LineResolution } from '@/server/services/po-imports-variants';

interface CreateItemsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poImportId: string;
  vendorId: string;
  warehouseId: string | null;
  /** Optional charter the new items belong to. */
  charterId?: string | null;
  /** Optional specific location within the warehouse for the new items. */
  locationId?: string | null;
  /** Create the new items as products (default) or books. */
  itemType?: 'product' | 'book';
  /** PO lines the user is creating internal items from. */
  lines: PoImportLineRow[];
  /**
   * Categories the items may be filed under. The chosen one decides the
   * tracking profile server-side, which is what turns a size run into one
   * product group instead of N unrelated items.
   */
  categories: Array<{ id: string; name: string; sportsSubcategoryKey: string | null }>;
  /** Server-resolved verdicts, keyed by line id (Task 14). */
  resolutions?: Record<string, LineResolution>;
  /** Called after a successful create so the parent can refresh data. */
  onSuccess: (counts: {
    created: number;
    mapped: number;
    linked: number;
    skipped: number;
  }) => void;
}

/**
 * Radix Select forbids an empty-string item value, so the "nothing chosen"
 * options need real sentinels.
 */
const NO_CATEGORY = '__none';
const NO_SIZE_SYSTEM = '__none';

type Decision =
  | { mode: 'create' }
  | { mode: 'use_existing'; itemId: string }
  | { mode: 'skip' };

/**
 * Strip the trailing "(SOMETHING)" off a PO line description. The
 * manufacturer's part number already lives in the barcode field, so
 * keeping it in the name is just clutter.
 *
 *   "Duracell Coppertop AA Alkaline Batteries, 24/Pack (MN1500B240001)"
 *   → "Duracell Coppertop AA Alkaline Batteries, 24/Pack"
 */
export function autoCleanItemName(description: string): string {
  return description.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function CreateItemsModal({
  open,
  onOpenChange,
  poImportId,
  vendorId,
  warehouseId,
  charterId,
  locationId,
  itemType,
  lines,
  categories,
  resolutions,
  onSuccess,
}: CreateItemsModalProps) {
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = React.useState<string>('');
  /**
   * Verdicts re-resolved for the CHOSEN category.
   *
   * The `resolutions` prop is resolved on the server before a category exists,
   * so for a create-mode line (item_id null) it can only ever say 'ready'. The
   * category is what decides the tracking profile, and therefore whether the
   * line needs a group, a size or a serial — so the moment the reviewer picks
   * one, the verdicts are recomputed against it. Read-only: nothing is written
   * or linked by asking.
   */
  const [liveResolutions, setLiveResolutions] =
    React.useState<Record<string, LineResolution> | null>(null);
  const [resolving, setResolving] = React.useState(false);
  const effectiveResolutions = liveResolutions ?? resolutions;
  // Per-line fixes for a missing required attribute, so a reviewer never has
  // to leave the screen. These never overwrite the line's stored source text.
  const [variants, setVariants] = React.useState<
    Record<string, { size?: string; sizeSystem?: string; jerseyNumber?: string }>
  >({});
  // Per-line answers to a possible_duplicate / ambiguous_variant_match verdict.
  // No default and no pre-selection: the suggestion is not a link until this
  // is set (the 0233 discipline, extended to groups).
  const [groupChoices, setGroupChoices] = React.useState<
    Record<string, { mode: 'new' | 'link'; groupId?: string }>
  >({});
  const [decisions, setDecisions] = React.useState<Record<string, Decision>>({});
  const [duplicates, setDuplicates] = React.useState<Record<string, DuplicateCandidate[]>>({});
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Reset the editable name map every time the modal opens with a new
  // set of lines so we don't carry stale edits between batches.
  React.useEffect(() => {
    if (!open) return;
    const seed: Record<string, string> = {};
    const seedDecisions: Record<string, Decision> = {};
    for (const l of lines) {
      const desc = (l.description ?? '').trim();
      seed[l.id] = autoCleanItemName(desc) || desc;
      seedDecisions[l.id] = { mode: 'create' };
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    setNames(seed);
    setDecisions(seedDecisions);
    setDuplicates({});
    setVariants({});
    setGroupChoices({});
    setLiveResolutions(null);

    // Scan for duplicate candidates per line. Matching is ADVISORY ONLY:
    // a barcode/name hit surfaces the yellow "possible duplicate" notice
    // below, but the per-line decision stays 'create' unless the user
    // explicitly clicks a candidate. We never auto-flip to 'use_existing'
    // — the chosen charter is the source of truth, and every order should
    // default to creating its own instance under that charter rather than
    // silently merging into whatever org happened to buy the part first.
    setScanning(true);
    findDuplicatesForPoLinesAction({
      poImportId,
      lineIds: lines.map((l) => l.id),
    })
      .then((r) => {
        if (!r.ok) {
          // Non-fatal — proceed without dedup hints.
          console.warn('duplicate scan failed', r.error.message);
          return;
        }
        setDuplicates(r.data.matches);
      })
      .finally(() => setScanning(false));
  }, [open, lines, poImportId]);

  // Re-resolve whenever the chosen category changes (including back to none).
  // Group choices made against the OLD category's candidates are dropped: they
  // answered a question that no longer exists, and carrying them forward could
  // link a group the new verdict never offered.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- the category is an
       input to a SERVER read, and the stale answers have to be cleared the
       moment it changes; both calls are the "start of an async fetch" case,
       not derived state. */
    setResolving(true);
    setGroupChoices({});
    /* eslint-enable react-hooks/set-state-in-effect */
    resolvePoImportLineResultsAction({ poImportId, categoryId: categoryId || null })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          // Non-fatal: fall back to the server-rendered verdicts. The create
          // call re-resolves server-side regardless, so nothing slips through.
          console.warn('line verdict resolve failed', r.error.message);
          return;
        }
        setLiveResolutions(r.data);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, poImportId, categoryId]);

  function resetToCleaned(lineId: string) {
    const l = lines.find((x) => x.id === lineId);
    if (!l) return;
    const desc = (l.description ?? '').trim();
    setNames((m) => ({ ...m, [lineId]: autoCleanItemName(desc) || desc }));
  }

  function setDecision(lineId: string, decision: Decision) {
    setDecisions((m) => ({ ...m, [lineId]: decision }));
  }

  async function submit() {
    // Validate: every line in 'create' mode needs a non-empty name.
    const blank = lines.find(
      (l) => decisions[l.id]?.mode === 'create' && !(names[l.id] ?? '').trim(),
    );
    if (blank) {
      toast.error(`Line ${blank.line_number} needs a name before creating items.`);
      return;
    }
    // Validate: lines in 'use_existing' need an itemId.
    const unmappedLink = lines.find((l) => {
      const d = decisions[l.id];
      return d?.mode === 'use_existing' && !d.itemId;
    });
    if (unmappedLink) {
      toast.error(`Line ${unmappedLink.line_number} is set to use existing, but no item was picked.`);
      return;
    }
    // Every blocked line needs an explicit answer. The server refuses these
    // too — this check only makes the refusal legible before a round trip.
    const unanswered = lines.find((l) => {
      // Only CREATE-mode lines are resolved server-side: a skipped line is not
      // imported, and a use_existing line points at an item whose identity a
      // human already settled.
      if (decisions[l.id]?.mode !== 'create') return false;
      const res = effectiveResolutions?.[l.id];
      if (!res || !BLOCKING_LINE_RESULTS.has(res.result)) return false;
      const settleable =
        res.result === 'possible_duplicate' || res.result === 'ambiguous_variant_match';
      return !settleable || !groupChoices[l.id];
    });
    if (unanswered) {
      const res = effectiveResolutions?.[unanswered.id];
      toast.error(
        `Line ${unanswered.line_number}: ${res?.message ?? 'this line needs review before it can be imported.'}`,
      );
      return;
    }
    setBusy(true);
    const r = await createItemsFromPoLinesAction({
      poImportId,
      lineIds: lines.map((l) => l.id),
      vendorId,
      warehouseId,
      charterId: charterId ?? null,
      locationId: locationId ?? null,
      itemType: itemType ?? 'product',
      categoryId: categoryId || null,
      groupDecisions: Object.keys(groupChoices).length > 0 ? groupChoices : undefined,
      variantOverrides: Object.fromEntries(
        Object.entries(variants)
          .map(([id, v]) => [
            id,
            {
              size: v.size?.trim() || null,
              sizeSystem: v.sizeSystem || null,
              jerseyNumber: v.jerseyNumber?.trim() || null,
            },
          ])
          // Only send lines the reviewer actually touched, so an untouched
          // line keeps whatever the document said.
          .filter(([, v]) => {
            const o = v as Record<string, string | null>;
            return o.size != null || o.sizeSystem != null || o.jerseyNumber != null;
          }),
      ),
      nameOverrides: Object.fromEntries(
        Object.entries(names).map(([id, n]) => [id, n.trim()]),
      ),
      decisions: Object.fromEntries(
        Object.entries(decisions).map(([id, d]) => [
          id,
          d.mode === 'use_existing'
            ? { mode: 'use_existing' as const, itemId: d.itemId }
            : { mode: d.mode },
        ]),
      ),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    onSuccess(r.data);
    onOpenChange(false);
  }

  const isSingle = lines.length === 1;

  // Footer counts: tell the user what will actually happen on submit.
  let createCount = 0;
  let linkCount = 0;
  let skipCount = 0;
  for (const l of lines) {
    const d = decisions[l.id];
    if (d?.mode === 'use_existing') linkCount++;
    else if (d?.mode === 'skip') skipCount++;
    else createCount++;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="flex h-[90vh] max-h-[90vh] w-[calc(100vw-2rem)] max-w-[1100px] flex-col overflow-hidden p-0 sm:w-[calc(100vw-3rem)]"
      >
        <DialogHeader className="border-border space-y-1 border-b px-6 pb-4 pt-6">
          <DialogTitle>
            Review {lines.length} {isSingle ? 'line' : 'lines'} from PO
          </DialogTitle>
          <p className="text-muted-foreground text-xs">
            Names are pre-filled from the PO description with the trailing part
            number stripped (it's already saved in the barcode field). Every
            row creates a new item under the chosen charter by default. If a
            row matches an existing inventory item by barcode or name, you'll
            see a yellow notice — a match is only a suggestion, so click "Use
            existing" to explicitly link to it instead, or leave "Create
            anyway" selected if it's actually a different SKU.
            {scanning && ' (scanning for matches…)'}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="text-muted-foreground text-xs">Category</label>
            <div className="min-w-[240px]">
              <Select
                value={categoryId || NO_CATEGORY}
                onValueChange={(v) => setCategoryId(v === NO_CATEGORY ? '' : v)}
                disabled={busy}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="No category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.sportsSubcategoryKey ? ' (sports)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-muted-foreground text-[11px]">
              A Sports category groups a size run into one product; every other
              category behaves exactly as before.
              {resolving && ' (checking what each line will do…)'}
            </span>
          </div>
        </DialogHeader>

        <div className="border-border bg-card divide-border mx-6 my-4 flex-1 divide-y overflow-y-auto rounded-md border text-sm">
          {lines.map((l) => {
            const original = (l.description ?? '').trim();
            const cleaned = autoCleanItemName(original) || original;
            const current = names[l.id] ?? cleaned;
            const isCleaned = current === cleaned;
            const dupes = duplicates[l.id] ?? [];
            const decision = decisions[l.id] ?? { mode: 'create' };
            const res = effectiveResolutions?.[l.id];
            const blocked =
              decision.mode === 'create' && res != null && BLOCKING_LINE_RESULTS.has(res.result);
            const groupChoice = groupChoices[l.id];
            const v = variants[l.id] ?? {};

            return (
              <div key={l.id} className="space-y-2 p-3">
                <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                  <span className="font-mono">Line {l.line_number}</span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {l.qty_ordered_original} {l.uom_original}
                  </span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {l.unit_cost != null ? formatCurrency(l.unit_cost) : '—'} unit
                  </span>
                  {l.vendor_item_number && (
                    <>
                      <span>·</span>
                      <span className="font-mono">vendor #{l.vendor_item_number}</span>
                    </>
                  )}
                </div>

                {dupes.length > 0 && (
                  <div className="border-warning/40 bg-warning/5 space-y-2 rounded-md border px-2.5 py-2">
                    <div className="flex items-start gap-1.5 text-[11px]">
                      <AlertTriangle className="text-warning mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Possible duplicate
                        {dupes.length === 1 ? '' : 's'} of an item already in
                        inventory:
                      </span>
                    </div>
                    {dupes.map((c) => {
                      const picked =
                        decision.mode === 'use_existing' && decision.itemId === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() =>
                            setDecision(l.id, { mode: 'use_existing', itemId: c.id })
                          }
                          disabled={busy}
                          className={
                            'flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
                            (picked
                              ? 'border-foreground bg-foreground/5'
                              : 'border-border hover:border-foreground/60')
                          }
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{c.name}</div>
                            <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10.5px]">
                              <span>{c.sku}</span>
                              {c.barcode && (
                                <>
                                  <span>·</span>
                                  <span>{c.barcode}</span>
                                </>
                              )}
                              <span>·</span>
                              <span>{formatNumber(c.quantityOnHand)} on hand</span>
                              <span>·</span>
                              <span className="uppercase tracking-wider">
                                {c.matchType === 'barcode'
                                  ? 'barcode match'
                                  : 'name match'}
                              </span>
                            </div>
                          </div>
                          <span className="text-[10.5px] uppercase tracking-wider">
                            {picked ? 'using' : 'use'}
                          </span>
                        </button>
                      );
                    })}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={decision.mode === 'create' ? 'default' : 'ghost'}
                        className="h-6 text-[11px]"
                        onClick={() => setDecision(l.id, { mode: 'create' })}
                        disabled={busy}
                      >
                        Create anyway
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={decision.mode === 'skip' ? 'default' : 'ghost'}
                        className="h-6 text-[11px]"
                        onClick={() => setDecision(l.id, { mode: 'skip' })}
                        disabled={busy}
                      >
                        Skip line
                      </Button>
                    </div>
                  </div>
                )}

                {decision.mode === 'create' && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={current}
                      onChange={(e) =>
                        setNames((m) => ({ ...m, [l.id]: e.target.value }))
                      }
                      placeholder="Item name"
                      maxLength={200}
                      disabled={busy}
                    />
                    {!isCleaned && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => resetToCleaned(l.id)}
                        disabled={busy}
                        title="Reset to auto-cleaned PO description"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
                {blocked && (
                  <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border px-2.5 py-2 text-[11px]">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="text-destructive mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        <strong>{LINE_RESULT_LABELS[res.result]}</strong>
                        {res.message ? ` — ${res.message}` : ''}
                      </span>
                    </div>
                    {/*
                      An ambiguous VARIANT match: the group is settled, the
                      question is which existing variant this line is. Picking
                      one switches the line to use_existing so it receives into
                      that variant rather than spawning a duplicate of it.
                    */}
                    {res.variantCandidates.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {res.variantCandidates.map((vc) => (
                          <Button
                            key={vc.id}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10.5px]"
                            disabled={busy}
                            onClick={() =>
                              setDecision(l.id, { mode: 'use_existing', itemId: vc.id })
                            }
                          >
                            Receive into {vc.name} · {vc.sku}
                          </Button>
                        ))}
                      </div>
                    )}
                    {res.groupCandidates.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {res.groupCandidates.map((c) => {
                          const picked =
                            groupChoice?.mode === 'link' && groupChoice.groupId === c.id;
                          return (
                            <Button
                              key={c.id}
                              type="button"
                              size="sm"
                              variant={picked ? 'default' : 'outline'}
                              className="h-6 text-[10.5px]"
                              disabled={busy}
                              onClick={() =>
                                setGroupChoices((m) => ({
                                  ...m,
                                  [l.id]: { mode: 'link', groupId: c.id },
                                }))
                              }
                            >
                              Link to {c.name}
                            </Button>
                          );
                        })}
                        <Button
                          type="button"
                          size="sm"
                          variant={groupChoice?.mode === 'new' ? 'default' : 'outline'}
                          className="h-6 text-[10.5px]"
                          disabled={busy}
                          onClick={() =>
                            setGroupChoices((m) => ({ ...m, [l.id]: { mode: 'new' } }))
                          }
                        >
                          {/*
                            'new' means "not one of those candidates". With a
                            group already matched exactly it keeps that group
                            and adds a variant; with only a SUGGESTED group it
                            confirms a brand-new one. Same decision, two
                            honest labels.
                          */}
                          {res.groupId
                            ? 'Add a new variant to this group'
                            : 'Confirm a new group'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {decision.mode === 'create' && (
                  // Per-line variant inputs, so a missing required attribute
                  // can be supplied here instead of after the fact. Blank means
                  // "the document said nothing" and stays that way — nothing is
                  // guessed or defaulted.
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={v.size ?? l.variant_size ?? ''}
                      onChange={(e) =>
                        setVariants((m) => ({
                          ...m,
                          [l.id]: { ...(m[l.id] ?? {}), size: e.target.value },
                        }))
                      }
                      placeholder="Size"
                      maxLength={40}
                      disabled={busy}
                      className="h-8 w-[110px] text-xs"
                    />
                    <div className="w-[150px]">
                      <Select
                        value={v.sizeSystem ?? l.variant_size_system ?? NO_SIZE_SYSTEM}
                        onValueChange={(val) =>
                          setVariants((m) => ({
                            ...m,
                            [l.id]: {
                              ...(m[l.id] ?? {}),
                              sizeSystem: val === NO_SIZE_SYSTEM ? '' : val,
                            },
                          }))
                        }
                        disabled={busy}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Size system" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_SIZE_SYSTEM}>No size system</SelectItem>
                          {SIZE_SYSTEMS.map((sys) => (
                            <SelectItem key={sys} value={sys}>
                              {sys.replace(/_/g, ' ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      value={v.jerseyNumber ?? l.jersey_number ?? ''}
                      onChange={(e) =>
                        setVariants((m) => ({
                          ...m,
                          [l.id]: { ...(m[l.id] ?? {}), jerseyNumber: e.target.value },
                        }))
                      }
                      // NEVER labelled "serial": a uniform number is not one,
                      // and leading zeroes are meaningful, so this stays text.
                      placeholder="Number"
                      maxLength={4}
                      disabled={busy}
                      className="h-8 w-[90px] text-xs"
                    />
                  </div>
                )}

                {decision.mode === 'create' && original !== current && (
                  <p className="text-muted-foreground truncate text-[11px]">
                    PO original: {original}
                  </p>
                )}
                {decision.mode === 'skip' && (
                  <p className="text-muted-foreground text-[11px] italic">
                    This line will be skipped — handle it later by mapping or
                    creating manually.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="border-border bg-background border-t px-6 py-4">
          <div className="text-muted-foreground mr-auto self-center text-[11px]">
            {createCount > 0 && <span>{createCount} new</span>}
            {createCount > 0 && (linkCount > 0 || skipCount > 0) && <span> · </span>}
            {linkCount > 0 && <span>{linkCount} linked</span>}
            {linkCount > 0 && skipCount > 0 && <span> · </span>}
            {skipCount > 0 && <span>{skipCount} skipped</span>}
          </div>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || resolving} variant="gradient">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
