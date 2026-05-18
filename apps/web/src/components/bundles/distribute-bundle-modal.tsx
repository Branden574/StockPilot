'use client';

import { AlertTriangle, CheckCircle2, Loader2, Send } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  distributeBundleAction,
  previewBundleDistributionAction,
} from '@/server/actions/bundles';
import { formatNumber } from '@/lib/utils';

interface Preview {
  fromPhantom: number;
  fromComponents: number;
  components: Array<{
    itemId: string;
    itemName: string;
    itemSku: string;
    perBundleQty: number;
    isOptional: boolean;
    needed: number;
    available: number;
    drawnFromComponents: number;
    shortage: number;
  }>;
  hasShortage: boolean;
  totalShortageItems: number;
  totalShortageUnits: number;
}

interface Props {
  bundleId: string;
  bundleName: string;
  warehouses: Array<{ id: string; name: string }>;
  upcomingEvents?: Array<{ id: string; title: string; startsAt: string }>;
}

const NO_EVENT = '__none';

export function DistributeBundleModal({
  bundleId,
  bundleName,
  warehouses,
  upcomingEvents = [],
}: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [quantity, setQuantity] = React.useState('1');
  const [warehouseId, setWarehouseId] = React.useState(warehouses[0]?.id ?? '');
  const [scheduleEventId, setScheduleEventId] = React.useState<string>(NO_EVENT);
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setPreview(null);
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !warehouseId) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const res = await previewBundleDistributionAction({
        id: bundleId,
        quantity: qty,
        warehouseId,
      });
      if (ctrl.signal.aborted) return;
      setPreviewing(false);
      if (!res.ok) {
        setPreview(null);
        return;
      }
      setPreview(res.data as unknown as Preview);
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [open, quantity, warehouseId, bundleId]);

  async function submit() {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a positive quantity.');
      return;
    }
    if (!warehouseId) {
      toast.error('Pick a warehouse to distribute from.');
      return;
    }
    const allowShortage = preview?.hasShortage ?? false;
    setBusy(true);
    const res = await distributeBundleAction({
      id: bundleId,
      quantity: qty,
      warehouseId,
      scheduleEventId: scheduleEventId === NO_EVENT ? null : scheduleEventId,
      notes: notes.trim() || null,
      allowShortage,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      allowShortage
        ? `Distributed ${qty} ${bundleName} kit${qty === 1 ? '' : 's'} (with shortage logged).`
        : `Distributed ${qty} ${bundleName} kit${qty === 1 ? '' : 's'}.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="gradient">
          <Send className="h-3.5 w-3.5" />
          Distribute
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Distribute {bundleName}</DialogTitle>
          <DialogDescription>
            Drains pre-assembled kits first, then components for any
            remainder. Live preview shows what will be drawn.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dist-qty">Quantity</Label>
              <Input
                id="dist-qty"
                type="number"
                min={1}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Warehouse</Label>
              <Select value={warehouseId} onValueChange={setWarehouseId} disabled={busy}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a warehouse" />
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
          </div>

          {upcomingEvents.length > 0 && (
            <div className="space-y-1.5">
              <Label>Linked event (optional)</Label>
              <Select
                value={scheduleEventId}
                onValueChange={setScheduleEventId}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EVENT}>None</SelectItem>
                  {upcomingEvents.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.title} —{' '}
                      {new Date(e.startsAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="dist-notes">Notes (optional)</Label>
            <Textarea
              id="dist-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              disabled={busy}
            />
          </div>

          <PreviewBlock preview={preview} previewing={previewing} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={preview?.hasShortage ? 'destructive' : 'gradient'}
            onClick={submit}
            disabled={busy || previewing || !preview}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {preview?.hasShortage
              ? `Distribute with shortage`
              : `Distribute ${formatNumber(Number(quantity) || 0)} kit${Number(quantity) === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBlock({
  preview,
  previewing,
}: {
  preview: Preview | null;
  previewing: boolean;
}) {
  if (previewing && !preview) {
    return (
      <div className="border-border bg-muted/30 rounded-md border p-3 text-xs text-muted-foreground">
        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
        Calculating preview…
      </div>
    );
  }
  if (!preview) {
    return null;
  }

  const fromComponents = preview.components.filter(
    (c) => c.drawnFromComponents > 0 || c.shortage > 0,
  );

  return (
    <div className="space-y-2">
      {preview.fromPhantom > 0 && (
        <div className="border-border bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-start gap-2 rounded-md border border-emerald-500/30 p-3 text-xs">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <div>
            <div className="font-medium">
              {formatNumber(preview.fromPhantom)} kit
              {preview.fromPhantom === 1 ? '' : 's'} from pre-assembled stock
            </div>
          </div>
        </div>
      )}
      {preview.fromComponents > 0 && (
        <div
          className={`border-border flex items-start gap-2 rounded-md border p-3 text-xs ${
            preview.hasShortage
              ? 'bg-destructive/10 text-destructive border-destructive/30'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
          }`}
        >
          {preview.hasShortage ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          )}
          <div className="flex-1">
            <div className="font-medium">
              {formatNumber(preview.fromComponents)} kit
              {preview.fromComponents === 1 ? '' : 's'} from individual components
            </div>
            <div className="mt-1.5 space-y-0.5 font-mono">
              {fromComponents.map((c) => (
                <div key={c.itemId} className="flex items-center gap-2">
                  <span className="flex-1 truncate">
                    {c.itemName}
                    {c.isOptional && (
                      <span className="text-muted-foreground ml-1 text-[10.5px]">
                        (optional)
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    -{formatNumber(c.drawnFromComponents)}
                  </span>
                  {c.shortage > 0 && !c.isOptional && (
                    <span className="text-destructive tabular-nums font-semibold">
                      ⚠ {formatNumber(c.shortage)} short
                    </span>
                  )}
                </div>
              ))}
            </div>
            {preview.hasShortage && (
              <p className="mt-2 text-[11.5px] font-medium">
                Distribution will record {formatNumber(preview.totalShortageUnits)}{' '}
                missing unit{preview.totalShortageUnits === 1 ? '' : 's'} as a
                shortage marker. Confirm to proceed.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
