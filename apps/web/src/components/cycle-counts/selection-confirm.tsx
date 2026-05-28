'use client';

import { Loader2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

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
  selectCountList,
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

export function SelectionConfirm({
  members,
  canAssign,
}: {
  members: CountMember[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const picks = useCountSelection(selectCountList);
  const remove = useCountSelection((s) => s.remove);
  const clear = useCountSelection((s) => s.clear);
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
    clear();
    router.push(`/dashboard/cycle-counts/${r.data.id}`);
  }

  if (picks.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          No items selected yet. Open Inventory or Books, tick the items you
          want to count, and choose <span className="font-medium">Cycle count</span>{' '}
          from the actions bar.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/inventory">Go to Inventory</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/books">Go to Books</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {products.length > 0 && (
          <PickGroup title="Products" picks={products} onRemove={remove} />
        )}
        {books.length > 0 && (
          <PickGroup title="Books" picks={books} onRemove={remove} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/inventory">
            <Plus className="mr-1 h-3.5 w-3.5" /> Add more items
          </Link>
        </Button>
        <button
          type="button"
          onClick={clear}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <X className="h-3.5 w-3.5" /> Clear all
        </button>
      </div>

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

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm tabular-nums">
          {picks.length} item{picks.length === 1 ? '' : 's'} selected
        </span>
        <Button onClick={start} disabled={busy} variant="gradient">
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
