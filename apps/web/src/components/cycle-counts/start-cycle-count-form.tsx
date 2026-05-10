'use client';

import { Loader2 } from 'lucide-react';
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
import { startCycleCountAction } from '@/server/actions/cycle-counts';

const ALL = '__all';

export function StartCycleCountForm({
  warehouses,
}: {
  warehouses: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState<string>(ALL);
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function start() {
    setBusy(true);
    const r = await startCycleCountAction({
      warehouseId: warehouseId === ALL ? null : warehouseId,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(
      `Cycle count started. Snapshot covers ${r.data.lineCount} item${r.data.lineCount === 1 ? '' : 's'}.`,
    );
    router.push(`/dashboard/cycle-counts/${r.data.id}`);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Warehouse</Label>
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All warehouses</SelectItem>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Restrict the count to one warehouse, or leave at "All warehouses" to
          recount every active item in the org.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>
          Notes
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. Quarterly count · DC4 · Q2 2026"
          maxLength={2000}
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={start} disabled={busy} variant="gradient">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Start count'
          )}
        </Button>
      </div>
    </div>
  );
}
