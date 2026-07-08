'use client';

import { Check, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, ScanBarcode, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Textarea } from '@/components/ui/textarea';
import {
  addItemSerialsAction,
  deleteItemSerialAction,
  listItemSerialsAction,
  updateItemSerialAction,
} from '@/server/actions/serials';
import { cn, formatRelative } from '@/lib/utils';

/** Mirrors serial_registry.current_status (migration 0015 CHECK). */
const SERIAL_STATUSES = ['available', 'reserved', 'damaged', 'rejected', 'sold', 'rma'] as const;
type SerialStatus = (typeof SERIAL_STATUSES)[number];

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<SerialStatus, string> = {
  available: 'Available',
  reserved: 'Reserved',
  damaged: 'Damaged',
  rejected: 'Rejected',
  sold: 'Sold',
  rma: 'RMA',
};

// Same tonal badge treatment as shipping-panel.tsx / fefo-lot-hint.tsx:
// tinted background + colored text, dark-mode variants included.
const STATUS_STYLES: Record<SerialStatus, string> = {
  available: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  reserved: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  damaged: 'bg-red-500/15 text-red-600 dark:text-red-400',
  rejected: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  sold: 'bg-muted text-muted-foreground',
  rma: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

/** Client-safe row shape — structurally identical to the service's SerialRow. */
export interface SerialPanelRow {
  id: string;
  serialNumber: string;
  currentStatus: SerialStatus;
  warehouseId: string;
  warehouseName: string | null;
  receiptLineId: string | null;
  createdAt: string;
}

interface ItemSerialsPanelProps {
  itemId: string;
  /** Gates the Add / edit / delete affordances (server re-asserts 'items:update'). */
  canEditItems: boolean;
  /** Active warehouses for the Add dialog's destination select. */
  warehouses: Array<{ id: string; name: string }>;
  /** First page, loaded server-side by item-detail. */
  initialRows: SerialPanelRow[];
  initialTotal: number;
}

function StatusBadge({ status }: { status: SerialStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Trim, drop empties, de-dupe (first-seen order) — mirrors the service. */
function parseSerialLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function ItemSerialsPanel({
  itemId,
  canEditItems,
  warehouses,
  initialRows,
  initialTotal,
}: ItemSerialsPanelProps) {
  const router = useRouter();

  const [rows, setRows] = React.useState<SerialPanelRow[]>(initialRows);
  const [total, setTotal] = React.useState(initialTotal);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);

  // Per-row inline errors (edit/status/delete failures) — persistent
  // role="alert" next to the row, not toast-only (repo pattern #20).
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const setRowError = React.useCallback((id: string, message: string | null) => {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }, []);

  // Inline serial-number editing.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [savingId, setSavingId] = React.useState<string | null>(null);

  // Delete confirmation.
  const [deleteTarget, setDeleteTarget] = React.useState<SerialPanelRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // Add-serials dialog.
  const [addOpen, setAddOpen] = React.useState(false);
  const [addWarehouseId, setAddWarehouseId] = React.useState(
    warehouses.length === 1 ? (warehouses[0]?.id ?? '') : '',
  );
  const [addText, setAddText] = React.useState('');
  const [addSubmitting, setAddSubmitting] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const loadPage = React.useCallback(
    async (nextPage: number) => {
      setLoading(true);
      const res = await listItemSerialsAction(itemId, nextPage);
      setLoading(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setRows(res.data.rows as SerialPanelRow[]);
      setTotal(res.data.total);
      setPage(res.data.page);
    },
    [itemId],
  );

  function startEdit(row: SerialPanelRow) {
    setEditingId(row.id);
    setEditValue(row.serialNumber);
    setRowError(row.id, null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue('');
  }

  async function saveEdit(row: SerialPanelRow) {
    const next = editValue.trim();
    if (!next) {
      setRowError(row.id, 'Serial number cannot be empty.');
      return;
    }
    if (next === row.serialNumber) {
      cancelEdit();
      return;
    }
    setSavingId(row.id);
    setRowError(row.id, null);
    const res = await updateItemSerialAction({ id: row.id, serialNumber: next });
    setSavingId(null);
    if (!res.ok) {
      setRowError(row.id, res.error.message);
      toast.error(res.error.message);
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, serialNumber: res.data.serialNumber } : r)),
    );
    cancelEdit();
    toast.success('Serial number updated.');
    router.refresh();
  }

  async function changeStatus(row: SerialPanelRow, status: SerialStatus) {
    if (status === row.currentStatus) return;
    setSavingId(row.id);
    setRowError(row.id, null);
    const res = await updateItemSerialAction({ id: row.id, status });
    setSavingId(null);
    if (!res.ok) {
      setRowError(row.id, res.error.message);
      toast.error(res.error.message);
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, currentStatus: res.data.currentStatus } : r)),
    );
    toast.success(`Marked ${STATUS_LABELS[status].toLowerCase()}.`);
    router.refresh();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await deleteItemSerialAction({ id: deleteTarget.id });
    setDeleting(false);
    if (!res.ok) {
      setRowError(deleteTarget.id, res.error.message);
      toast.error(res.error.message);
      setDeleteTarget(null);
      return;
    }
    toast.success('Serial deleted.');
    setDeleteTarget(null);
    // Reload — deleting the last row of a trailing page steps back one page.
    const nextTotal = Math.max(0, total - 1);
    const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
    void loadPage(Math.min(page, lastPage));
    router.refresh();
  }

  const parsedAdd = parseSerialLines(addText);

  async function submitAdd() {
    if (!addWarehouseId) {
      setAddError('Pick a warehouse.');
      return;
    }
    if (parsedAdd.length === 0) {
      setAddError('Enter at least one serial number.');
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    const res = await addItemSerialsAction({
      itemId,
      warehouseId: addWarehouseId,
      serials: parsedAdd,
    });
    setAddSubmitting(false);
    if (!res.ok) {
      // Persistent inline error INSIDE the dialog (repo pattern #20 — a toast
      // alone auto-dismisses and reads as "nothing happened").
      setAddError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Added ${res.data.added} serial ${res.data.added === 1 ? 'number' : 'numbers'}.`,
    );
    setAddOpen(false);
    setAddText('');
    void loadPage(1);
    router.refresh();
  }

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScanBarcode className="h-4 w-4" /> Serial numbers
            </CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {total === 0
                ? 'No serial numbers registered yet.'
                : `${total} registered serial ${total === 1 ? 'number' : 'numbers'}.`}
            </p>
          </div>
          {canEditItems && (
            <Dialog
              open={addOpen}
              onOpenChange={(open) => {
                setAddOpen(open);
                if (open) {
                  setAddError(null);
                  if (warehouses.length === 1) setAddWarehouseId(warehouses[0]?.id ?? '');
                }
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4" /> Add serials
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add serial numbers</DialogTitle>
                  <DialogDescription>
                    Register serial numbers for this item. One serial per line — duplicates
                    within the list are ignored.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Warehouse</Label>
                    <Select value={addWarehouseId} onValueChange={setAddWarehouseId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select warehouse" />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="serials-input">Serial numbers</Label>
                    <Textarea
                      id="serials-input"
                      rows={6}
                      value={addText}
                      placeholder={'SN-0001\nSN-0002\nSN-0003'}
                      onChange={(e) => setAddText(e.target.value)}
                      className="font-mono"
                    />
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {parsedAdd.length} serial {parsedAdd.length === 1 ? 'number' : 'numbers'} to
                      add
                      {parsedAdd.length > 500 ? ' — maximum is 500 per batch' : ''}
                    </p>
                  </div>
                </div>

                {addError && (
                  <p role="alert" className="text-sm text-destructive">
                    {addError}
                  </p>
                )}

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setAddOpen(false)}
                    disabled={addSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submitAdd}
                    disabled={
                      addSubmitting ||
                      !addWarehouseId ||
                      parsedAdd.length === 0 ||
                      parsedAdd.length > 500
                    }
                  >
                    {addSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : parsedAdd.length > 0 ? (
                      `Add ${parsedAdd.length} serial${parsedAdd.length === 1 ? '' : 's'}`
                    ) : (
                      'Add serials'
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {canEditItems
              ? 'Serials are captured automatically when receiving a PO, or add them manually above.'
              : 'Serials are captured automatically when receiving a PO.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serial number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Added</TableHead>
                  {canEditItems && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isManual = row.receiptLineId === null;
                  const isEditing = editingId === row.id;
                  const isSaving = savingId === row.id;
                  const error = rowErrors[row.id];
                  return (
                    <TableRow key={row.id} data-testid={`serial-row-${row.id}`}>
                      <TableCell className="font-mono text-xs">
                        {isEditing ? (
                          <span className="flex items-center gap-1">
                            <Input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveEdit(row);
                                if (e.key === 'Escape') cancelEdit();
                              }}
                              className="h-7 w-40 font-mono text-xs"
                              maxLength={128}
                              autoFocus
                              aria-label="Serial number"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => void saveEdit(row)}
                              disabled={isSaving}
                              aria-label="Save serial number"
                            >
                              {isSaving ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={cancelEdit}
                              disabled={isSaving}
                              aria-label="Cancel edit"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {row.serialNumber}
                            {canEditItems && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => startEdit(row)}
                                aria-label={`Edit serial ${row.serialNumber}`}
                              >
                                <Pencil className="text-muted-foreground h-3 w-3" />
                              </Button>
                            )}
                          </span>
                        )}
                        {error && (
                          <p role="alert" className="text-destructive mt-1 text-xs">
                            {error}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {canEditItems ? (
                          <Select
                            value={row.currentStatus}
                            onValueChange={(v) => void changeStatus(row, v as SerialStatus)}
                            disabled={isSaving}
                          >
                            <SelectTrigger
                              className="h-7 w-auto gap-1 border-none bg-transparent px-1 shadow-none"
                              aria-label={`Status for serial ${row.serialNumber}`}
                            >
                              <StatusBadge status={row.currentStatus} />
                            </SelectTrigger>
                            <SelectContent>
                              {SERIAL_STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {STATUS_LABELS[s]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge status={row.currentStatus} />
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {isManual ? 'Manual' : 'PO receipt'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.warehouseName ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatRelative(row.createdAt)}
                      </TableCell>
                      {canEditItems && (
                        <TableCell>
                          {isManual && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => setDeleteTarget(row)}
                              aria-label={`Delete serial ${row.serialNumber}`}
                            >
                              <Trash2 className="text-muted-foreground hover:text-destructive h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between">
            <p className="text-muted-foreground text-xs tabular-nums">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadPage(page - 1)}
                disabled={loading || page <= 1}
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadPage(page + 1)}
                disabled={loading || page >= totalPages}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <DestructiveConfirm
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete serial number?"
        description={
          <>
            This removes{' '}
            <span className="text-foreground font-mono font-medium">
              {deleteTarget?.serialNumber}
            </span>{' '}
            from the registry. Serials captured from a PO receipt can&apos;t be deleted — this
            one was added manually.
          </>
        }
        confirmLabel="Delete"
        pending={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </Card>
  );
}
