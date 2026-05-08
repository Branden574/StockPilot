'use client';

import { Loader2, Search, UserCircle2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber } from '@/lib/utils';
import {
  assignCycleCountAction,
  cancelCycleCountAction,
  clearCycleCountLineAction,
  postCycleCountAction,
  recordCycleCountLineAction,
} from '@/server/actions/cycle-counts';

import type {
  CycleCountLineWithItem,
  CycleCountRow,
} from '@/server/services/cycle-counts';

interface Member {
  id: string;
  name: string;
  email: string;
}

interface Props {
  header: CycleCountRow;
  lines: CycleCountLineWithItem[];
  /** Whether the current user has cycle_counts:assign (manager / admin /
      owner). When false, the AssigneePicker renders read-only. */
  canAssign?: boolean;
  /** Org members eligible for assignment. Only populated when
      `canAssign` is true. */
  members?: Member[];
  /** Display name of the current assignee, resolved server-side so the
      read-only badge has a name to show. */
  assigneeName?: string | null;
}

export function CycleCountDetail({
  header,
  lines,
  canAssign = false,
  members = [],
  assigneeName = null,
}: Props) {
  const router = useRouter();
  const [search, setSearch] = React.useState('');
  const [busyLine, setBusyLine] = React.useState<string | null>(null);
  const [postBusy, setPostBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<'all' | 'uncounted' | 'variance'>('all');

  const completed = header.status === 'completed';
  const canceled = header.status === 'canceled';
  const open = header.status === 'in_progress';

  const term = search.trim().toLowerCase();
  const visibleLines = lines.filter((l) => {
    const item = l.item;
    if (!item) return false;
    if (filter === 'uncounted' && l.counted_quantity !== null) return false;
    if (filter === 'variance') {
      if (l.counted_quantity === null) return false;
      const variance = l.counted_quantity - l.expected_quantity;
      if (variance === 0) return false;
    }
    if (!term) return true;
    return (
      item.name.toLowerCase().includes(term) ||
      item.sku.toLowerCase().includes(term) ||
      (item.barcode ?? '').toLowerCase().includes(term)
    );
  });

  // Summary
  const counted = lines.filter((l) => l.counted_quantity !== null);
  const uncounted = lines.length - counted.length;
  const variances = counted.filter(
    (l) => (l.counted_quantity ?? 0) - l.expected_quantity !== 0,
  );
  const totalDelta = variances.reduce(
    (sum, l) => sum + ((l.counted_quantity ?? 0) - l.expected_quantity),
    0,
  );

  async function saveCount(line: CycleCountLineWithItem, raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter a non-negative number');
      return;
    }
    setBusyLine(line.id);
    const r = await recordCycleCountLineAction({
      cycleCountId: header.id,
      lineId: line.id,
      countedQuantity: value,
    });
    setBusyLine(null);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    router.refresh();
  }

  async function clearLine(line: CycleCountLineWithItem) {
    setBusyLine(line.id);
    const r = await clearCycleCountLineAction({
      cycleCountId: header.id,
      lineId: line.id,
    });
    setBusyLine(null);
    if (!r.ok) toast.error(r.error.message);
    else router.refresh();
  }

  async function cancel() {
    if (!confirm('Cancel this count? No adjustments will be posted.')) return;
    const r = await cancelCycleCountAction(header.id);
    if (!r.ok) toast.error(r.error.message);
    else {
      toast.success('Count canceled');
      router.refresh();
    }
  }

  async function post() {
    setPostBusy(true);
    const r = await postCycleCountAction(header.id);
    setPostBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setConfirmOpen(false);
    toast.success(
      variances.length === 0
        ? 'Count completed — no adjustments needed'
        : `Posted ${variances.length} adjustment${variances.length === 1 ? '' : 's'}`,
    );
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={header.status} />
        <span className="text-muted-foreground text-xs">
          {counted.length} of {lines.length} counted · {variances.length} with variance
        </span>
        {open && (
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={postBusy}>
              Cancel count
            </Button>
            <Button
              variant="gradient"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={postBusy || counted.length === 0}
            >
              Review & post
            </Button>
          </div>
        )}
      </div>

      <AssigneePicker
        cycleCountId={header.id}
        currentAssignedTo={header.assigned_to}
        currentAssigneeName={assigneeName}
        canAssign={canAssign && open}
        members={members}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Items in scope" value={formatNumber(lines.length)} />
        <Stat label="Counted" value={formatNumber(counted.length)} />
        <Stat label="Uncounted" value={formatNumber(uncounted)} tone={uncounted > 0 ? 'warn' : 'default'} />
        <Stat
          label="Net variance"
          value={`${totalDelta > 0 ? '+' : ''}${formatNumber(totalDelta)}`}
          tone={totalDelta !== 0 ? 'warn' : 'default'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, SKU, barcode…"
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
        <FilterChips value={filter} onChange={setFilter} />
      </div>

      <div className="bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleLines.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-8 text-center text-xs"
                >
                  {lines.length === 0
                    ? 'No items in this count.'
                    : 'No items match the current filter.'}
                </TableCell>
              </TableRow>
            )}
            {visibleLines.map((l) => (
              <CountRow
                key={l.id}
                line={l}
                disabled={!open}
                busy={busyLine === l.id}
                onSave={(value) => saveCount(l, value)}
                onClear={() => clearLine(l)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(o) => !postBusy && setConfirmOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Post this count?</DialogTitle>
          </DialogHeader>
          <div className="text-muted-foreground space-y-2 text-sm">
            <p>
              This will post{' '}
              <strong className="text-foreground">{variances.length}</strong>{' '}
              adjustment{variances.length === 1 ? '' : 's'} (net{' '}
              <strong className="text-foreground">
                {totalDelta > 0 ? '+' : ''}
                {formatNumber(totalDelta)}
              </strong>{' '}
              units) and update inventory to match the counted quantities.
            </p>
            {uncounted > 0 && (
              <p className="text-warning">
                {uncounted} item{uncounted === 1 ? '' : 's'} weren't counted —
                they'll be left unchanged.
              </p>
            )}
            <p className="text-[11px]">
              Stock movements are recorded as <code>adjust</code> with reason
              "Cycle count adjustment". This is irreversible — but you can
              create a corrective adjustment afterwards if needed.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={postBusy}>
              Back
            </Button>
            <Button onClick={post} disabled={postBusy} variant="gradient">
              {postBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Post adjustments'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(completed || canceled) && (
        <p className="text-muted-foreground text-xs">
          This count is {completed ? 'completed' : 'canceled'}. Lines are
          read-only.
        </p>
      )}
    </div>
  );
}

function CountRow({
  line,
  disabled,
  busy,
  onSave,
  onClear,
}: {
  line: CycleCountLineWithItem;
  disabled: boolean;
  busy: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = React.useState<string>(
    line.counted_quantity != null ? String(line.counted_quantity) : '',
  );

  React.useEffect(() => {
    setDraft(line.counted_quantity != null ? String(line.counted_quantity) : '');
  }, [line.counted_quantity]);

  const variance =
    line.counted_quantity != null
      ? line.counted_quantity - line.expected_quantity
      : null;

  return (
    <TableRow>
      <TableCell className="max-w-[280px]">
        <div className="truncate font-medium">{line.item?.name ?? 'Unknown'}</div>
        {line.item?.barcode && (
          <div className="text-muted-foreground truncate font-mono text-[10.5px]">
            {line.item.barcode}
          </div>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">
        {line.item?.sku ?? '—'}
      </TableCell>
      <TableCell className="text-muted-foreground text-right tabular-nums">
        {formatNumber(line.expected_quantity)}
      </TableCell>
      <TableCell className="text-right">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (disabled) return;
            const trimmed = draft.trim();
            if (trimmed === '') return; // empty = leave uncounted
            const next = Number(trimmed);
            const current = line.counted_quantity;
            if (Number.isFinite(next) && next !== current) onSave(trimmed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          placeholder="—"
          inputMode="decimal"
          disabled={disabled || busy}
          className="ml-auto h-8 max-w-[110px] text-right text-[12.5px] tabular-nums"
        />
      </TableCell>
      <TableCell
        className={
          'text-right font-mono tabular-nums ' +
          (variance == null
            ? 'text-muted-foreground'
            : variance > 0
              ? 'text-success'
              : variance < 0
                ? 'text-destructive'
                : 'text-muted-foreground')
        }
      >
        {variance == null
          ? '—'
          : variance === 0
            ? '0'
            : `${variance > 0 ? '+' : ''}${formatNumber(variance)}`}
      </TableCell>
      <TableCell>
        {!disabled && line.counted_quantity != null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClear}
            disabled={busy}
            title="Clear count"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function FilterChips({
  value,
  onChange,
}: {
  value: 'all' | 'uncounted' | 'variance';
  onChange: (v: 'all' | 'uncounted' | 'variance') => void;
}) {
  const opts: Array<{ key: typeof value; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'uncounted', label: 'Uncounted' },
    { key: 'variance', label: 'Variance' },
  ];
  return (
    <div className="flex gap-1">
      {opts.map((o) => (
        <Button
          key={o.key}
          type="button"
          variant={value === o.key ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div
      className={
        'rounded-md border bg-card px-3 py-2 ' +
        (tone === 'warn' ? 'border-warning/40' : 'border-border')
      }
    >
      <p className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <p
        className={
          'mt-1 text-base font-semibold tabular-nums ' +
          (tone === 'warn' ? 'text-warning' : '')
        }
      >
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'in_progress') return <Badge variant="warning">In progress</Badge>;
  if (status === 'completed') return <Badge variant="success">Completed</Badge>;
  if (status === 'canceled') return <Badge variant="destructive">Canceled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

const UNASSIGNED = '__unassigned__';

/**
 * Assignment row for the cycle count. Manager+ get a Select dropdown to
 * pick a member (or unassign); staff/viewers see a read-only badge with
 * the current assignee's name.
 */
function AssigneePicker({
  cycleCountId,
  currentAssignedTo,
  currentAssigneeName,
  canAssign,
  members,
}: {
  cycleCountId: string;
  currentAssignedTo: string | null;
  currentAssigneeName: string | null;
  canAssign: boolean;
  members: Member[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function setAssignee(next: string) {
    const nextId = next === UNASSIGNED ? null : next;
    if (nextId === currentAssignedTo) return;
    setBusy(true);
    const res = await assignCycleCountAction({
      id: cycleCountId,
      assignedTo: nextId,
      // Optimistic-concurrency: the page rendered with the current
      // assignee, so pass it as expected. If a teammate changed it
      // between page load and our click, we'll get a clean error.
      expectedAssignee: currentAssignedTo,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      nextId ? 'Assigned' : 'Unassigned',
    );
    router.refresh();
  }

  // Read-only display for staff/viewers, or when the count is closed.
  if (!canAssign) {
    return (
      <div className="border-border bg-card flex items-center gap-2 rounded-md border px-3 py-2 text-[12.5px]">
        <UserCircle2 className="text-muted-foreground h-4 w-4" />
        <span className="text-muted-foreground">Assigned to:</span>
        <span className="font-medium">{currentAssigneeName ?? 'Unassigned'}</span>
      </div>
    );
  }

  return (
    <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[12.5px]">
      <UserCircle2 className="text-muted-foreground h-4 w-4" />
      <span className="text-muted-foreground">Assigned to:</span>
      <Select
        value={currentAssignedTo ?? UNASSIGNED}
        onValueChange={setAssignee}
        disabled={busy}
      >
        <SelectTrigger className="h-8 min-w-[200px] text-[12.5px]">
          <SelectValue placeholder="Pick a member" />
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
      {busy && <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />}
    </div>
  );
}
