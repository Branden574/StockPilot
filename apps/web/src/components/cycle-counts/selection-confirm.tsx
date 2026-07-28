'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

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
    if (r.data.skipped > 0) {
      toast.message(
        `Started with ${r.data.lineCount} item${r.data.lineCount === 1 ? '' : 's'}; ${r.data.skipped} were archived or removed.`,
      );
    } else {
      toast.success(
        `Cycle count started · ${r.data.lineCount} item${r.data.lineCount === 1 ? '' : 's'}.`,
      );
    }
    useCountSelection.getState().clear();
    router.push(`/dashboard/cycle-counts/${r.data.id}`);
  }

  return (
    <div className="space-y-5">
      <CountItemPicker warehouses={warehouses} sportsEnabled={sportsEnabled} />

      {picks.length > 0 && (
        <div className="space-y-3">
          {products.length > 0 && (
            <PickGroup title="Products" picks={products} onRemove={remove} />
          )}
          {books.length > 0 && (
            <PickGroup title="Books" picks={books} onRemove={remove} />
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label>
          Notes
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. Spot count · Rack 3 chargers"
          maxLength={2000}
        />
      </div>

      {canAssign && (
        <div className="space-y-1.5">
          <Label>
            Assign to
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger>
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
          <p className="text-muted-foreground text-xs">
            The assignee gets a notification to start the count.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm">
          {picks.length === 0 ? (
            'Pick at least one item above to start a count.'
          ) : (
            <span className="tabular-nums">
              {picks.length} item{picks.length === 1 ? '' : 's'} selected
            </span>
          )}
        </span>
        <Button onClick={start} disabled={busy || picks.length === 0} variant="gradient">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Start count'}
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
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {title} · {picks.length}
      </p>
      <ul className="divide-border border-border divide-y rounded-md border">
        {picks.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm">{p.name}</p>
              {p.sku ? (
                <p className="text-muted-foreground truncate font-mono text-xs">{p.sku}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onRemove(p.id)}
              aria-label={`Remove ${p.name}`}
              className="text-muted-foreground hover:text-destructive shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
