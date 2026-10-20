'use client';

import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { STICKY_ACTIONS } from '@/components/admin/sticky-actions';
import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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
import { cn } from '@/lib/utils';
import { archiveBinAction, createBinAction } from '@/server/actions/bins';

import type { BinRow, BinType } from '@/server/services/bins';

const BIN_TYPES: BinType[] = ['receiving', 'storage', 'qa_hold', 'damaged', 'rejected', 'shipping'];

export function BinsManager({
  warehouses,
  bins,
}: {
  warehouses: Array<{ id: string; name: string }>;
  bins: BinRow[];
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState(warehouses[0]?.id ?? '');
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [binType, setBinType] = React.useState<BinType>('storage');
  const [isDefault, setIsDefault] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<BinRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  // Why the last archive was refused, shown inside the confirm (a toast
  // alone sits behind the open dialog). Cleared on open and on each try.
  const [archiveError, setArchiveError] = React.useState<string | null>(null);

  const grouped = React.useMemo(() => {
    const m = new Map<string, BinRow[]>();
    for (const b of bins) {
      const arr = m.get(b.warehouse_id) ?? [];
      arr.push(b);
      m.set(b.warehouse_id, arr);
    }
    return m;
  }, [bins]);

  async function add() {
    if (!warehouseId || !code.trim() || !name.trim()) {
      toast.error('Warehouse, code, and name are required to create a bin.');
      return;
    }
    setBusy(true);
    const r = await createBinAction({
      warehouseId,
      code: code.trim(),
      name: name.trim(),
      binType,
      isDefault,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setCode('');
    setName('');
    setIsDefault(false);
    toast.success(`Bin "${name.trim()}" created.`);
    router.refresh();
  }
  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    setArchiveError(null);
    const r = await archiveBinAction(archiveTarget.id);
    setArchiveBusy(false);
    if (!r.ok) {
      setArchiveError(r.error.message);
      toast.error(r.error.message);
      return;
    }
    setArchiveTarget(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <DetailSection title="Add bin">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bin-warehouse">Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger id="bin-warehouse">
                <SelectValue />
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
            <Label htmlFor="bin-type">Type</Label>
            <Select value={binType} onValueChange={(v) => setBinType(v as BinType)}>
              <SelectTrigger id="bin-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BIN_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bin-code">Code</Label>
            <Input
              id="bin-code"
              placeholder="A-12, BAY-3, QA-01"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bin-name">Name</Label>
            <Input
              id="bin-name"
              placeholder="Aisle A, Bay 12"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {/* The shared checkbox: its words are part of the one control, as
              the native label made them; it still resets after a save. */}
          <Checkbox
            checked={isDefault}
            onCheckedChange={setIsDefault}
            className="text-ink-2 self-center text-[13px]"
          >
            Default for this {binType.replace(/_/g, ' ')} type (one allowed per warehouse)
          </Checkbox>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={add} disabled={busy} variant="gradient" aria-busy={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save bin
          </Button>
        </div>
      </DetailSection>

      {warehouses.map((w) => {
        const list = grouped.get(w.id) ?? [];
        return (
          <DetailSection
            key={w.id}
            headingLevel={3}
            headingId={`bins-${w.id}-heading`}
            title={w.name}
            aside={
              <DetailSectionMeta>
                {list.length} bin{list.length === 1 ? '' : 's'}
              </DetailSectionMeta>
            }
            flush
          >
            {/* From sm up, fixed column widths, so every warehouse card lines up
                with the next. A phone keeps the auto layout it had, so Code, Name,
                Type and the Default tick stay in view, and Archive is pinned to
                the card's right edge if the row is still too wide. */}
            <Table
              scrollLabelledBy={`bins-${w.id}-heading`}
              className="sm:min-w-[520px] sm:table-fixed"
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="sm:w-[22%]">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="sm:w-[20%]">Type</TableHead>
                  <TableHead className="text-center sm:w-24">Default</TableHead>
                  <TableHead className={cn('w-16 text-right', STICKY_ACTIONS)} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                      No bins yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  list.map((b) => (
                    <TableRow key={b.id}>
                      {/* A long code or name wraps inside its fixed column (a code
                          of up to 32 letters, digits, dashes and underscores has
                          no break of its own) instead of running into the next. */}
                      <TableCell className="break-words font-mono text-[12.5px]">
                        {b.code}
                      </TableCell>
                      <TableCell className="break-words">{b.name}</TableCell>
                      <TableCell className="text-ink-2">{b.bin_type.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-center">
                        {b.is_default ? (
                          // A tick for the eye and the word for a screen
                          // reader (the bare check-mark glyph read as nothing).
                          <span className="text-success inline-flex items-center justify-center">
                            <Check className="h-4 w-4" aria-hidden />
                            <span className="sr-only">Default</span>
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className={cn('text-right', STICKY_ACTIONS)}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setArchiveError(null);
                            setArchiveTarget(b);
                          }}
                          aria-label="Archive"
                        >
                          <Trash2 className="text-muted-foreground h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </DetailSection>
        );
      })}

      <DestructiveConfirm
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive bin "${archiveTarget.code}"?` : 'Archive bin?'}
        description="Stock movements can no longer happen to or from this bin. Any current on-hand stock stays attached to the bin until you move it. You can restore the bin later from the archived view."
        confirmLabel="Archive"
        pending={archiveBusy}
        error={archiveError}
        onConfirm={confirmArchive}
      />
    </div>
  );
}
