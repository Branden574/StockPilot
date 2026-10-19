'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { cycleCountStartedMessage } from '@stockpilot/core';

import { CountItemPicker } from '@/components/cycle-counts/count-item-picker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useCountPicks,
  useCountSelection,
  type CountPick,
} from '@/lib/cycle-counts/use-count-selection';
import { startCycleCountAction } from '@/server/actions/cycle-counts';

const UNASSIGNED = '__unassigned';

export interface CountMember {
  id: string;
  name: string;
  email: string;
}

/**
 * The "Selected items" scope: an embedded Inventory/Books picker (search,
 * tick items in place — no round-trip through the list pages) followed by
 * the confirm form. Selection lives in the shared count-selection store,
 * so the legacy path (Items/Books select-mode → "Cycle count" action)
 * lands here with its picks pre-checked and both paths converge.
 *
 * The footer (how many are picked, and Start count) sticks to the bottom of
 * the window while the form runs past it, so a long selection never pushes
 * the start out of reach. It spans the form card's 18 px padding edge to edge.
 */
export function SelectionConfirm({
  members,
  canAssign,
  warehouses,
  sportsEnabled = false,
}: {
  members: CountMember[];
  canAssign: boolean;
  warehouses: Array<{ id: string; name: string }>;
  /** Org has the sports module — unlocks the Product groups tab. */
  sportsEnabled?: boolean;
}) {
  const router = useRouter();
  const picks = useCountPicks();
  const remove = useCountSelection((s) => s.remove);
  const [notes, setNotes] = React.useState('');
  const [assignee, setAssignee] = React.useState<string>(UNASSIGNED);
  const [busy, setBusy] = React.useState(false);
  const notesId = React.useId();
  const assignId = React.useId();

  const books = picks.filter((p) => p.itemType === 'book');
  const products = picks.filter((p) => p.itemType !== 'book');

  async function start() {
    if (picks.length === 0) return;
    setBusy(true);
    const r = await startCycleCountAction({
      scope: 'selection',
      warehouseId: null,
      itemIds: picks.map((p) => p.id),
      notes: notes.trim() || null,
      assignedTo: assignee === UNASSIGNED ? null : assignee,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    // Skipped picks are archived or removed items, or (0369, D8) rental
    // equipment and kits, which counts never include. One sentence, shared
    // with the phone.
    const summary = cycleCountStartedMessage(r.data.lineCount, r.data.skipped);
    if (r.data.skipped > 0) {
      toast.message(summary);
    } else {
      toast.success(summary);
    }
    useCountSelection.getState().clear();
    router.push(`/dashboard/cycle-counts/${r.data.id}`);
  }

  return (
    <div className="flex flex-col gap-5">
      <CountItemPicker warehouses={warehouses} sportsEnabled={sportsEnabled} />

      {picks.length > 0 && (
        <div className="flex flex-col gap-3">
          {products.length > 0 && <PickGroup title="Products" picks={products} onRemove={remove} />}
          {books.length > 0 && <PickGroup title="Books" picks={books} onRemove={remove} />}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={notesId}>
          Notes
          <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
        </Label>
        <Textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. Spot count · Rack 3 chargers"
          maxLength={2000}
        />
      </div>

      {canAssign && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={assignId}>
            Assign to
            <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
          </Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger id={assignId} className="sm:max-w-[320px]">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[12px]">
            The assignee gets a notification to start the count.
          </p>
        </div>
      )}

      <div className="border-border bg-card sticky bottom-0 z-10 -mx-[18px] -mb-[18px] flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t px-[18px] py-3">
        <span className="text-muted-foreground text-[13px]">
          {picks.length === 0 ? (
            'Pick at least one item above to start a count.'
          ) : (
            <span className="text-foreground font-medium tabular-nums">
              {picks.length} item{picks.length === 1 ? '' : 's'} selected
            </span>
          )}
        </span>
        <Button onClick={start} disabled={busy || picks.length === 0} variant="gradient">
          {busy ? (
            <>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              <span className="sr-only">Start count</span>
            </>
          ) : (
            'Start count'
          )}
        </Button>
      </div>
    </div>
  );
}

function PickGroup({
  title,
  picks,
  onRemove,
}: {
  title: string;
  picks: CountPick[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.06em]">
        {title} · {picks.length}
      </p>
      <ul className="divide-border border-border divide-y rounded-md border">
        {picks.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-1.5 pl-3 pr-1.5">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] leading-5">{p.name}</p>
              {p.sku ? (
                <p className="text-muted-foreground truncate font-mono text-[11.5px] leading-[17px]">
                  {p.sku}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemove(p.id)}
              aria-label={`Remove ${p.name}`}
              className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
            >
              <X aria-hidden className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
