'use client';

import { Archive, ClipboardList, FolderTree, Loader2, Truck, Undo2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  bulkUpdateInventoryAction,
  type BulkInventoryOp,
} from '@/server/actions/inventory';
import { createDraftPosFromItemsAction } from '@/server/actions/purchase-orders';

export interface BulkActionsCategory {
  id: string;
  name: string;
}

export interface BulkActionsSupplier {
  id: string;
  name: string;
}

interface BulkActionsProps {
  selectedIds: string[];
  categories: BulkActionsCategory[];
  suppliers: BulkActionsSupplier[];
  onClear: () => void;
  /** Whether any of the selected rows is currently archived. Drives the
      "Restore" vs "Archive" affordance. */
  hasArchivedSelection?: boolean;
}

type ActiveDialog =
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | { kind: 'set_category' }
  | { kind: 'set_supplier' }
  | null;

export function BulkActions({
  selectedIds,
  categories,
  suppliers,
  onClear,
  hasArchivedSelection,
}: BulkActionsProps) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<ActiveDialog>(null);
  const [busy, setBusy] = React.useState(false);
  const [categoryId, setCategoryId] = React.useState<string>('__none__');
  const [supplierId, setSupplierId] = React.useState<string>('__none__');

  const count = selectedIds.length;
  const [draftBusy, setDraftBusy] = React.useState(false);

  async function createDraftPos() {
    setDraftBusy(true);
    const r = await createDraftPosFromItemsAction(selectedIds);
    setDraftBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    const { createdPoIds, skipped, supplierFailures, supplierCount } = r.data;
    const created = createdPoIds.length;
    if (created === 0) {
      toast.error(
        supplierFailures.length > 0
          ? `Failed to create POs for ${supplierFailures.length} supplier${supplierFailures.length === 1 ? '' : 's'}.`
          : 'No draft POs created.',
      );
      return;
    }
    const parts: string[] = [
      `Created ${created} draft PO${created === 1 ? '' : 's'} across ${supplierCount} supplier${supplierCount === 1 ? '' : 's'}`,
    ];
    if (skipped > 0) {
      parts.push(`${skipped} skipped (no supplier)`);
    }
    if (supplierFailures.length > 0) {
      const names = supplierFailures.map((f) => f.supplierName).join(', ');
      parts.push(`failed: ${names}`);
    }
    toast.success(parts.join(' · '));
    onClear();
    router.push('/dashboard/purchase-orders?status=draft');
  }

  async function run(op: BulkInventoryOp) {
    setBusy(true);
    const r = await bulkUpdateInventoryAction({ ids: selectedIds, op });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    if (r.data.skipped > 0) {
      toast.success(
        `Updated ${r.data.ok} item${r.data.ok === 1 ? '' : 's'}. Skipped ${r.data.skipped} you don't have write access to.`,
      );
    } else {
      toast.success(
        `Updated ${r.data.ok} item${r.data.ok === 1 ? '' : 's'}.`,
      );
    }
    setDialog(null);
    onClear();
    router.refresh();
  }

  return (
    <>
      <div className="border-foreground/20 bg-card flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-[12.5px]">
        <span className="font-mono tabular-nums text-[var(--ed-ink-2)]">
          {count} selected
        </span>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <a
          href={`/dashboard/inventory/labels?items=${selectedIds.join(',')}`}
          className="text-[var(--ed-ink-2)] hover:text-foreground"
        >
          Print labels
        </a>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'set_category' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <FolderTree className="h-3 w-3" /> Set category
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'set_supplier' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <Truck className="h-3 w-3" /> Set supplier
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={createDraftPos}
          disabled={draftBusy}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground disabled:opacity-60"
        >
          {draftBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ClipboardList className="h-3 w-3" />
          )}{' '}
          Create draft POs
        </button>

        {hasArchivedSelection ? (
          <>
            <span className="text-[var(--ed-ink-4)]">·</span>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'unarchive' })}
              className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
            >
              <Undo2 className="h-3 w-3" /> Restore
            </button>
          </>
        ) : (
          <>
            <span className="text-[var(--ed-ink-4)]">·</span>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'archive' })}
              className="text-destructive inline-flex items-center gap-1 hover:underline"
            >
              <Archive className="h-3 w-3" /> Archive
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onClear}
          className="ml-auto inline-flex items-center gap-1 text-[var(--ed-ink-4)] hover:text-foreground"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      </div>

      {/* Archive confirmation */}
      <Dialog
        open={dialog?.kind === 'archive'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {count} item{count === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              Archived items are hidden from the default view but keep their
              history. You can restore them later by switching the view to
              Archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => run({ kind: 'archive' })}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation */}
      <Dialog
        open={dialog?.kind === 'unarchive'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore {count} item{count === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              This sets every selected item's status back to Active.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => run({ kind: 'unarchive' })}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set category */}
      <Dialog
        open={dialog?.kind === 'set_category'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set category on {count} item{count === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              Choose a category to apply to every selected item, or pick
              "No category" to clear it.
            </DialogDescription>
          </DialogHeader>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No category</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                run({
                  kind: 'set_category',
                  categoryId: categoryId === '__none__' ? null : categoryId,
                })
              }
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set supplier */}
      <Dialog
        open={dialog?.kind === 'set_supplier'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set supplier on {count} item{count === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              Choose a supplier to apply, or pick "No supplier" to clear it.
            </DialogDescription>
          </DialogHeader>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No supplier</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                run({
                  kind: 'set_supplier',
                  supplierId: supplierId === '__none__' ? null : supplierId,
                })
              }
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
