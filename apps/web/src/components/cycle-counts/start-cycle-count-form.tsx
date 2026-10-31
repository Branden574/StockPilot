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

/**
 * The "Whole warehouse" scope: snapshot one warehouse, or every active item in
 * the org, with optional notes. The footer matches the selection scope's (a
 * hairline bar across the form card's 18 px padding, Start count on the right).
 */
export function StartCycleCountForm({
  warehouses,
}: {
  warehouses: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState<string>(ALL);
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const warehouseFieldId = React.useId();
  const notesId = React.useId();

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
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={warehouseFieldId}>Warehouse</Label>
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger id={warehouseFieldId} className="sm:max-w-[320px]">
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
        <p className="text-muted-foreground text-[12px]">
          Restrict the count to one warehouse, or leave at &quot;All warehouses&quot; to recount
          every active item in the org.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={notesId}>
          Notes
          <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
        </Label>
        <Textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. Quarterly count · Main warehouse · Q2 2026"
          maxLength={2000}
        />
      </div>
      <div className="border-border -mx-[18px] -mb-[18px] flex justify-end rounded-b-lg border-t px-[18px] py-3">
        <Button onClick={start} disabled={busy} variant="gradient">
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
