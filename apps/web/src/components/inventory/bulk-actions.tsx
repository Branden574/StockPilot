'use client';

import {
  Archive,
  ClipboardCheck,
  ClipboardList,
  Download,
  FolderTree,
  Globe,
  Layers,
  Loader2,
  MapPin,
  Tags as TagsIcon,
  Truck,
  Undo2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  bulkUpdateInventoryAction,
  type BulkInventoryOp,
} from '@/server/actions/inventory';
import {
  bulkSetItemPublicVisibilityAction,
  type ItemPublicVisibility,
} from '@/server/actions/item-visibility';
import { createDraftPosFromItemsAction } from '@/server/actions/purchase-orders';
import { ExportBuilderDialog } from './export-builder/export-builder-dialog';

export interface BulkActionsCategory {
  id: string;
  name: string;
}

export interface BulkActionsSupplier {
  id: string;
  name: string;
}

export interface BulkActionsLocation {
  id: string;
  name: string;
}

export interface BulkActionsTag {
  id: string;
  name: string;
  color: string | null;
}

interface BulkActionsProps {
  selectedIds: string[];
  categories: BulkActionsCategory[];
  suppliers: BulkActionsSupplier[];
  locations: BulkActionsLocation[];
  /** Org tag list — drives the Add tags / Remove tags dialogs. Optional
      for callers that haven't loaded tags yet (defaults to []). When the
      list is empty both tag entries are still shown but the dialog
      surfaces an empty-state hint pointing at /dashboard/tags. */
  tags?: BulkActionsTag[];
  onClear: () => void;
  /** Whether any of the selected rows is currently archived. Drives the
      "Restore" vs "Archive" affordance. */
  hasArchivedSelection?: boolean;
  /** Whether any selected item's stock is split across >1 rack/crate
      holding (placed_racks.length > 1). Bulk Set rack PHYSICALLY MOVES a
      single-placement item's stock onto the new rack, but a split item is
      left label-only (moving it would be a guess — the op carries no
      fromLocationId). Drives an inline warning in the Set rack dialog
      pointing at Transfer. */
  hasSplitRackSelection?: boolean;
  /** Push the selected rows into the cycle-count selection and navigate to
      the New cycle count screen. Wired by InventoryTable. */
  onCycleCount: () => void;
  /** Public-catalog visibility (P3): shows the "Set public visibility" bulk
      action. Pages pass can(ctx, 'public_links:manage'); the server action
      re-asserts. Default false → hidden for older callers. */
  canSetPublicVisibility?: boolean;
}

type ActiveDialog =
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | { kind: 'set_category' }
  | { kind: 'set_supplier' }
  | { kind: 'set_location' }
  | { kind: 'set_rack' }
  | { kind: 'add_tags' }
  | { kind: 'remove_tags' }
  | { kind: 'set_public_visibility' }
  | null;

const PUBLIC_VISIBILITY_LABELS: Record<ItemPublicVisibility, string> = {
  internal_only: 'Internal only',
  public: 'Public',
  hidden: 'Hidden',
};

export function BulkActions({
  selectedIds,
  categories,
  suppliers,
  locations,
  tags = [],
  onClear,
  hasArchivedSelection,
  hasSplitRackSelection,
  onCycleCount,
  canSetPublicVisibility = false,
}: BulkActionsProps) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<ActiveDialog>(null);
  const [busy, setBusy] = React.useState(false);
  const [categoryId, setCategoryId] = React.useState<string>('__none__');
  const [supplierId, setSupplierId] = React.useState<string>('__none__');
  const [locationId, setLocationId] = React.useState<string>('__none__');
  const [rackNumber, setRackNumber] = React.useState<string>('');
  const [rackRow, setRackRow] = React.useState<string>('');
  // Tag selections are independent per dialog so opening Add → cancel →
  // Remove doesn't carry the previous picks over. Both reset on dialog
  // close.
  const [addTagIds, setAddTagIds] = React.useState<Set<string>>(new Set());
  const [removeTagIds, setRemoveTagIds] = React.useState<Set<string>>(new Set());
  const [publicVisibility, setPublicVisibility] =
    React.useState<ItemPublicVisibility>('internal_only');
  // Inline error surface for the public-visibility dialog (recurring bug
  // pattern #20: modal errors must render IN the modal, not just a toast).
  const [visibilityError, setVisibilityError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    if (dialog?.kind !== 'add_tags') setAddTagIds(new Set());
    if (dialog?.kind !== 'remove_tags') setRemoveTagIds(new Set());
    if (dialog?.kind !== 'set_rack') {
      setRackNumber('');
      setRackRow('');
    }
    if (dialog?.kind !== 'set_public_visibility') {
      setPublicVisibility('internal_only');
      setVisibilityError(null);
    }
  }, [dialog]);

  const count = selectedIds.length;
  const [draftBusy, setDraftBusy] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);

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
          ? `Couldn't create draft POs for ${supplierFailures.length} supplier${supplierFailures.length === 1 ? '' : 's'}. Try again or pick different items.`
          : "No draft POs were created. Check that the selected items have a default supplier set.",
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
    toast.success(`${parts.join(' · ')}.`);
    onClear();
    router.push('/dashboard/purchase-orders?status=draft');
  }

  async function applyPublicVisibility() {
    setBusy(true);
    setVisibilityError(null);
    const r = await bulkSetItemPublicVisibilityAction({
      itemIds: selectedIds,
      visibility: publicVisibility,
    });
    setBusy(false);
    if (!r.ok) {
      setVisibilityError(r.error.message);
      return;
    }
    toast.success(
      `Set ${r.data.updated} item${r.data.updated === 1 ? '' : 's'} to ${PUBLIC_VISIBILITY_LABELS[publicVisibility]}.`,
    );
    setDialog(null);
    onClear();
    router.refresh();
  }

  // The archive stock-guard block (2026-07-23): when a plain archive is refused
  // because the items still hold stock, we stash the message and offer an
  // explicit "Archive anyway" that re-runs with acknowledgeStock — the silent
  // orphan is dead, but a deliberate archive-with-stock stays one click away.
  const [pendingAckArchive, setPendingAckArchive] = React.useState<string | null>(null);

  async function run(op: BulkInventoryOp, opts: { acknowledgeStock?: boolean } = {}) {
    setBusy(true);
    const r = await bulkUpdateInventoryAction({
      ids: selectedIds,
      op,
      ...(opts.acknowledgeStock ? { acknowledgeStock: true } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      // Archive is the only op that raises a validation error, and only the
      // stock guard does — so a validation_error here is unambiguously "still
      // has stock". Offer the override instead of a dead-end toast.
      if (op.kind === 'archive' && r.error.code === 'validation_error' && !opts.acknowledgeStock) {
        setDialog(null);
        setPendingAckArchive(r.error.message);
        return;
      }
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
      <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-[12.5px]">
        {/* Leading checked box — the bar swaps in over the toolbar when rows
            are selected, so this sits right where the user's attention is.
            Mirrors the table's header select-all: one click unselects
            everything (same as the Clear button at the far end). Visuals
            match the table Checkbox exactly. */}
        <button
          type="button"
          role="checkbox"
          aria-checked="true"
          title="Unselect all"
          aria-label={`Unselect all ${count} selected item${count === 1 ? '' : 's'}`}
          onClick={onClear}
          className="inline-grid h-5 w-5 place-items-center rounded-[5px] border border-foreground bg-foreground transition-colors"
        >
          <span
            aria-hidden
            className="h-[11px] w-[6px] -translate-y-px rotate-45 border-b-2 border-r-2 border-background"
          />
        </button>
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
          onClick={() => setExportOpen(true)}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <Download className="h-3 w-3" /> Export
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={onCycleCount}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <ClipboardCheck className="h-3 w-3" /> Cycle count
        </button>

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

        {canSetPublicVisibility && (
          <>
            <span className="text-[var(--ed-ink-4)]">·</span>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'set_public_visibility' })}
              className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
            >
              <Globe className="h-3 w-3" /> Set public visibility
            </button>
          </>
        )}

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'add_tags' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <TagsIcon className="h-3 w-3" /> Add tags
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'remove_tags' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <TagsIcon className="h-3 w-3" /> Remove tags
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'set_location' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <MapPin className="h-3 w-3" /> Set location
        </button>

        <span className="text-[var(--ed-ink-4)]">·</span>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'set_rack' })}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <Layers className="h-3 w-3" /> Set rack
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

      <ExportBuilderDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        scope="selected"
        itemType="all"
        selectedIds={selectedIds}
        rowCountHint={selectedIds.length}
      />

      {/* Archive confirmation */}
      <DestructiveConfirm
        open={dialog?.kind === 'archive'}
        onOpenChange={(v) => {
          if (!v) setDialog(null);
        }}
        title={`Archive ${count} item${count === 1 ? '' : 's'}?`}
        description="Archived items are hidden from the default view but keep their history. You can restore them later by switching the view to Archived."
        confirmLabel="Archive"
        pending={busy}
        onConfirm={() => run({ kind: 'archive' })}
      />

      {/* Archive-with-stock override: shown only after the guard refuses. */}
      <Dialog
        open={pendingAckArchive !== null}
        onOpenChange={(v) => (v ? null : setPendingAckArchive(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive with stock still on hand?</DialogTitle>
            <DialogDescription>{pendingAckArchive}</DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            Archiving hides {count === 1 ? 'this item' : 'these items'} from the active view but keeps
            the stock on the books — it stays counted in valuation until you remove it. Remove the
            stock first if you want it off the count.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingAckArchive(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setPendingAckArchive(null);
                void run({ kind: 'archive' }, { acknowledgeStock: true });
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Archive anyway'}
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

      {/* Set location (primary_location_id) */}
      <Dialog
        open={dialog?.kind === 'set_location'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set location on {count} item{count === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              Set the primary stocking location for every selected item, or
              pick "No location" to clear it. This does not move on-hand
              stock between warehouses.
            </DialogDescription>
          </DialogHeader>
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No location</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
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
                  kind: 'set_location',
                  locationId: locationId === '__none__' ? null : locationId,
                })
              }
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set rack */}
      <Dialog
        open={dialog?.kind === 'set_rack'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set rack on {count} item{count === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              Relabels every selected item with the same rack (e.g.{' '}
              <span className="font-mono">38-A</span>) and moves its stock
              onto that rack — for items that are staged, unplaced, or
              already on a single rack/crate. Items with stock on more than
              one rack are relabeled only; use Transfer to move those.
              Leave both fields empty to clear the rack.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-rack-number">Rack number</Label>
              <Input
                id="bulk-rack-number"
                placeholder="38"
                inputMode="numeric"
                value={rackNumber}
                onChange={(e) => setRackNumber(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-rack-row">Rack row</Label>
              <Input
                id="bulk-rack-row"
                placeholder="A"
                maxLength={4}
                value={rackRow}
                onChange={(e) =>
                  setRackRow(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                }
              />
            </div>
          </div>
          {hasSplitRackSelection && (
            <p className="rounded-md border border-amber-200 bg-amber-50/30 px-3 py-2 text-[12.5px] text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-400">
              Some selected items have stock split across multiple racks. Set
              rack updates their label only — to physically move stock, use
              Transfer.
            </p>
          )}
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
                  kind: 'set_rack',
                  rackNumber: rackNumber.trim() || null,
                  rackRow: rackRow.trim().toUpperCase() || null,
                })
              }
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add tags */}
      <TagsDialog
        kind="add"
        open={dialog?.kind === 'add_tags'}
        onClose={() => setDialog(null)}
        tags={tags}
        selected={addTagIds}
        onChange={setAddTagIds}
        count={count}
        busy={busy}
        onApply={() =>
          run({ kind: 'add_tags', tagIds: [...addTagIds] })
        }
      />

      {/* Remove tags */}
      <TagsDialog
        kind="remove"
        open={dialog?.kind === 'remove_tags'}
        onClose={() => setDialog(null)}
        tags={tags}
        selected={removeTagIds}
        onChange={setRemoveTagIds}
        count={count}
        busy={busy}
        onApply={() =>
          run({ kind: 'remove_tags', tagIds: [...removeTagIds] })
        }
      />

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

      {/* Set public visibility (P3 public-catalog controls) */}
      <Dialog
        open={dialog?.kind === 'set_public_visibility'}
        onOpenChange={(v) => (v ? null : setDialog(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Set public visibility on {count} item{count === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>
              Controls how these items can appear on public request links.
              &lsquo;Hidden&rsquo; beats everything — the item never appears publicly, even
              when hand-picked on a link. &lsquo;Public&rsquo; still requires the item&apos;s
              category to be public and a link that includes the public pool. Per-link
              curation lives in Settings → Public request links.
            </DialogDescription>
          </DialogHeader>
          <Select
            value={publicVisibility}
            onValueChange={(v) => setPublicVisibility(v as ItemPublicVisibility)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal_only">Internal only</SelectItem>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="hidden">Hidden</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[12.5px]">
            Set {count} item{count === 1 ? '' : 's'} to{' '}
            <span className="text-foreground font-medium">
              {PUBLIC_VISIBILITY_LABELS[publicVisibility]}
            </span>
            .
          </p>
          {visibilityError && (
            <p className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12.5px]">
              {visibilityError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={applyPublicVisibility} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TagsDialog({
  kind,
  open,
  onClose,
  tags,
  selected,
  onChange,
  count,
  busy,
  onApply,
}: {
  kind: 'add' | 'remove';
  open: boolean;
  onClose: () => void;
  tags: BulkActionsTag[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  count: number;
  busy: boolean;
  onApply: () => void;
}) {
  const isAdd = kind === 'add';
  const title = isAdd ? 'Add tags' : 'Remove tags';
  const desc = isAdd
    ? `Pick one or more tags to apply to ${count} item${count === 1 ? '' : 's'}. Tags already on a row are left alone.`
    : `Pick one or more tags to remove from ${count} item${count === 1 ? '' : 's'}. Items without those tags are unaffected.`;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {title} on {count} item{count === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        {tags.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-[12.5px] text-muted-foreground">
            No tags exist yet — create some on the{' '}
            <a className="underline" href="/dashboard/tags">
              Tags page
            </a>
            .
          </p>
        ) : (
          <div className="-mx-1 max-h-[260px] overflow-y-auto px-1">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const on = selected.has(t.id);
                const swatch = t.color ?? '#94a3b8';
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t.id)}
                    aria-pressed={on}
                    className={
                      on
                        ? 'inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[12px] text-white shadow-sm transition-colors'
                        : 'inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-muted'
                    }
                    style={on ? { backgroundColor: swatch } : undefined}
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: on ? 'rgba(255,255,255,0.85)' : swatch }}
                    />
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onApply} disabled={busy || selected.size === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
