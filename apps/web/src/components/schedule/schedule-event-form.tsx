'use client';

import { Loader2, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  createScheduleEventAction,
  deleteScheduleEventAction,
  updateScheduleEventAction,
} from '@/server/actions/schedule';

interface Defaults {
  id?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string | null;
  allDay?: boolean;
  locationText?: string | null;
  warehouseId?: string | null;
  requesterName?: string | null;
  details?: string | null;
  status?: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  bundleId?: string | null;
  bundleQuantity?: number | null;
  bundleWarehouseId?: string | null;
  bundleAlreadyDistributed?: boolean;
}

interface Props {
  warehouses: Array<{ id: string; name: string }>;
  bundles: Array<{ id: string; name: string; sku: string | null }>;
  defaults?: Defaults;
  /** When set, the date input is pre-filled. Format: YYYY-MM-DD. */
  initialDate?: string | null;
}

/** Convert an ISO string ("...Z" or with offset) to the local
 *  "YYYY-MM-DDTHH:mm" format that <input type="datetime-local"> wants. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a "YYYY-MM-DDTHH:mm" local string to a UTC ISO string. */
function localInputToIso(local: string): string {
  // The Date() constructor parses local-time format as local time on
  // the runtime. Then toISOString() emits UTC. That's what the schema
  // expects (datetime with offset).
  return new Date(local).toISOString();
}

const STATUS_OPTIONS: Array<{ value: Defaults['status']; label: string }> = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function ScheduleEventForm({ warehouses, bundles, defaults, initialDate }: Props) {
  const router = useRouter();
  const isEdit = Boolean(defaults?.id);

  // Initial start time: edit → existing, new + initialDate → 9 AM that day,
  // otherwise → next half-hour slot today.
  const initialStart = React.useMemo(() => {
    if (defaults?.startsAt) return isoToLocalInput(defaults.startsAt);
    if (initialDate) return `${initialDate}T09:00`;
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
    return isoToLocalInput(d.toISOString());
  }, [defaults?.startsAt, initialDate]);

  const initialEnd = React.useMemo(() => {
    if (defaults?.endsAt) return isoToLocalInput(defaults.endsAt);
    return '';
  }, [defaults?.endsAt]);

  const [title, setTitle] = React.useState(defaults?.title ?? '');
  const [startsAtLocal, setStartsAtLocal] = React.useState(initialStart);
  const [endsAtLocal, setEndsAtLocal] = React.useState(initialEnd);
  const [allDay, setAllDay] = React.useState(defaults?.allDay ?? false);
  const [locationText, setLocationText] = React.useState(defaults?.locationText ?? '');
  // Warehouse is required: events are now warehouse-scoped at the
  // RLS level (migration 0033). If the user doesn't pick one, the
  // event would only be visible to org members with no warehouse
  // restriction — a footgun. Default to the first warehouse the
  // caller passed in.
  const [warehouseId, setWarehouseId] = React.useState<string>(
    defaults?.warehouseId ?? warehouses[0]?.id ?? '',
  );
  const [requesterName, setRequesterName] = React.useState(defaults?.requesterName ?? '');
  const [details, setDetails] = React.useState(defaults?.details ?? '');
  const [status, setStatus] = React.useState<
    'scheduled' | 'in_progress' | 'completed' | 'cancelled'
  >(defaults?.status ?? 'scheduled');
  const [bundleId, setBundleId] = React.useState<string>(defaults?.bundleId ?? '');
  const [bundleQuantity, setBundleQuantity] = React.useState<string>(
    defaults?.bundleQuantity ? String(defaults.bundleQuantity) : '',
  );
  const [bundleWarehouseId, setBundleWarehouseId] = React.useState<string>(
    defaults?.bundleWarehouseId ?? '',
  );
  const [busy, setBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const bundleLocked = Boolean(defaults?.bundleAlreadyDistributed);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!warehouseId) {
      toast.error('Pick a warehouse — events are scoped to warehouse staff.');
      return;
    }
    setBusy(true);

    // Validate bundle linkage: if any of the 3 are set, all must be.
    const wantsBundle = Boolean(bundleId);
    const qty = Number(bundleQuantity);
    if (wantsBundle && (!bundleWarehouseId || !Number.isFinite(qty) || qty <= 0)) {
      toast.error('Bundle linkage needs quantity + warehouse together.');
      setBusy(false);
      return;
    }

    const payload = {
      title: title.trim(),
      startsAt: localInputToIso(startsAtLocal),
      endsAt: endsAtLocal ? localInputToIso(endsAtLocal) : null,
      allDay,
      locationText: locationText.trim() || undefined,
      warehouseId: warehouseId || null,
      requesterName: requesterName.trim() || undefined,
      details: details.trim() || undefined,
      status,
      bundleId: wantsBundle ? bundleId : null,
      bundleQuantity: wantsBundle ? qty : null,
      bundleWarehouseId: wantsBundle ? bundleWarehouseId : null,
    };

    try {
      const res = isEdit && defaults?.id
        ? await updateScheduleEventAction(defaults.id, payload)
        : await createScheduleEventAction(payload);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(isEdit ? 'Event updated' : 'Event created');
      router.push(`/dashboard/schedule/${res.data.id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function onDelete() {
    if (!defaults?.id) return;
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    if (!defaults?.id) return;
    setBusy(true);
    try {
      const res = await deleteScheduleEventAction(defaults.id);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setDeleteOpen(false);
      toast.success('Event deleted');
      router.push('/dashboard/schedule');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Donation drop · Fresno HQ"
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="starts">Starts</Label>
          <Input
            id="starts"
            type="datetime-local"
            value={startsAtLocal}
            onChange={(e) => setStartsAtLocal(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ends">Ends (optional)</Label>
          <Input
            id="ends"
            type="datetime-local"
            value={endsAtLocal}
            onChange={(e) => setEndsAtLocal(e.target.value)}
            min={startsAtLocal}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(e) => setAllDay(e.target.checked)}
          className="border-input h-3.5 w-3.5 rounded-[3px] border"
        />
        All day
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="location">Location</Label>
          <Input
            id="location"
            value={locationText}
            onChange={(e) => setLocationText(e.target.value)}
            placeholder="DC4 dock 2 / Customer site / 1234 Main St"
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            Warehouse <span className="text-destructive">*</span>
          </Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
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
          <p className="text-muted-foreground text-[11px]">
            Only staff assigned to this warehouse will see the event.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="requester">Requester</Label>
          <Input
            id="requester"
            value={requesterName}
            onChange={(e) => setRequesterName(e.target.value)}
            placeholder="Who asked for this work?"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select
            value={status}
            onValueChange={(v) =>
              setStatus(v as 'scheduled' | 'in_progress' | 'completed' | 'cancelled')
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value as string}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-border space-y-3 rounded-lg border bg-card/50 p-4">
        <div>
          <Label className="text-sm font-medium">Linked bundle (optional)</Label>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            When this event is marked complete, the bundle is automatically
            distributed at the selected warehouse. Leave blank to skip.
          </p>
        </div>

        {bundleLocked && (
          <p className="text-warning rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px]">
            This event already triggered a distribution. Editing the bundle
            here won't re-distribute or undo the original — adjust on the
            bundle page if needed.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Bundle</Label>
            <Select
              value={bundleId || '__none'}
              onValueChange={(v) => setBundleId(v === '__none' ? '' : v)}
              disabled={bundleLocked}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {bundles.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                    {b.sku ? ` (${b.sku})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Quantity</Label>
            <Input
              type="number"
              min={1}
              step="any"
              value={bundleQuantity}
              onChange={(e) => setBundleQuantity(e.target.value)}
              placeholder="0"
              disabled={bundleLocked || !bundleId}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Distribute from warehouse</Label>
          <Select
            value={bundleWarehouseId || '__none'}
            onValueChange={(v) => setBundleWarehouseId(v === '__none' ? '' : v)}
            disabled={bundleLocked || !bundleId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a warehouse" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">—</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="details">Details</Label>
        <Textarea
          id="details"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Job notes, contacts, equipment needed, anything the team should see at a glance."
          rows={5}
        />
      </div>

      <div className="flex items-center justify-between">
        {isEdit ? (
          <Button
            type="button"
            variant="outline"
            onClick={onDelete}
            disabled={busy}
            className="text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" variant="gradient" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {isEdit ? 'Save changes' : 'Create event'}
        </Button>
      </div>

      <DestructiveConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this event?"
        description="The event is removed from the schedule and from any teammates' calendars. Linked bundle quantities (if not already distributed) are released. This cannot be undone."
        confirmLabel="Delete event"
        pending={busy}
        onConfirm={confirmDelete}
      />
    </form>
  );
}
