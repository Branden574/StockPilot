'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { archiveBinAction, createBinAction } from '@/server/actions/bins';

import type { BinRow, BinType } from '@/server/services/bins';

const BIN_TYPES: BinType[] = [
  'receiving',
  'storage',
  'qa_hold',
  'damaged',
  'rejected',
  'shipping',
];

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
      toast.error('Warehouse, code, and name are required');
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
    toast.success('Bin saved');
    router.refresh();
  }
  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const r = await archiveBinAction(archiveTarget.id);
    setArchiveBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setArchiveTarget(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Add bin</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger>
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
            <Label>Type</Label>
            <Select value={binType} onValueChange={(v) => setBinType(v as BinType)}>
              <SelectTrigger>
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
            <Label>Code</Label>
            <Input
              placeholder="A-12, BAY-3, QA-01"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="Aisle A, Bay 12"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            Default for this {binType.replace(/_/g, ' ')} type (one allowed per warehouse)
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={add} disabled={busy} variant="gradient">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save bin
          </Button>
        </div>
      </div>

      {warehouses.map((w) => {
        const list = grouped.get(w.id) ?? [];
        return (
          <div key={w.id} className="rounded-xl border bg-card">
            <div className="border-b px-4 py-3">
              <h3 className="text-sm font-semibold">{w.name}</h3>
              <p className="text-muted-foreground text-xs">
                {list.length} bin{list.length === 1 ? '' : 's'}
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-center">Default</TableHead>
                  <TableHead className="w-12 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center text-xs">
                      No bins yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  list.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">{b.code}</TableCell>
                      <TableCell>{b.name}</TableCell>
                      <TableCell className="text-xs">{b.bin_type.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-center">
                        {b.is_default ? '✓' : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setArchiveTarget(b)}
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
          </div>
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
        onConfirm={confirmArchive}
      />
    </div>
  );
}
