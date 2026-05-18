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

/** A nearby event we should consider for the overlap warning. */
interface ConflictCandidate {
  id: string;
  title: string;
  startsAt: string;
  /** May be null — open-ended events count as a single point at startsAt. */
  endsAt: string | null;
  warehouseId: string | null;
  requesterName: string | null;
}

interface Props {
  warehouses: Array<{ id: string; name: string }>;
  bundles: Array<{ id: string; name: string; sku: string | null }>;
  defaults?: Defaults;
  /** When set, the date input is pre-filled. Format: YYYY-MM-DD. */
  initialDate?: string | null;
  /**
   * Pre-loaded events near this form's anchor date, scoped to events
   * the caller can see. Used purely for the client-side overlap
   * warning — no submit-blocking. Same warehouse + intersecting
   * [startsAt, endsAt] window triggers a toast.
   *
   * Note: recurring events are NOT supported by the data model.
   * Every entry here is a single-occurrence event; no expansion is
   * required client-side.
   */
  conflictCandidates?: ConflictCandidate[];
}

/**
 * Convert an ISO string ("...Z" or with offset) to the local
 * "YYYY-MM-DDTHH:mm[:ss]" format that <input type="datetime-local">
 * accepts. Seconds are emitted only when non-zero so we don't show
 * ":00" by default — but if an event was scheduled to a second-precise
 * time, we preserve it across edit-save round trips.
 *
 * DST caveat: <input type="datetime-local"> is timezone-naïve. On the
 * spring-forward hour (e.g. 2:30am the day DST starts) the time literally
 * doesn't exist locally. new Date("YYYY-MM-DDT02:30") quietly snaps it
 * forward to 03:30. We accept this — it matches how every other web
 * calendar app behaves, and the org-timezone settings feature would be
 * the right place to fix it properly (out of scope here).
 */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const seconds = d.getSeconds();
  return seconds === 0 ? base : `${base}:${pad(seconds)}`;
}

/** Convert a "YYYY-MM-DDTHH:mm[:ss]" local string to a UTC ISO string. */
function localInputToIso(local: string): string {
  // The Date() constructor parses local-time format as local time on
  // the runtime. Then toISOString() emits UTC. That's what the schema
  // expects (datetime with offset).
  return new Date(local).toISOString();
}

/** Clamp datetime-local input to a sane civilian range. */
const MIN_LOCAL_DATETIME = '1970-01-01T00:00';
const MAX_LOCAL_DATETIME = '2100-12-31T23:59';

const STATUS_OPTIONS: Array<{ value: Defaults['status']; label: string }> = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function ScheduleEventForm({
  warehouses,
  bundles,
  defaults,
  initialDate,
  conflictCandidates = [],
}: Props) {
  const router = useRouter();
  const isEdit = Boolean(defaults?.id);

  // Initial start time: edit → existing, new + initialDate → 9 AM that day,
  // otherwise → next half-hour slot today.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memo intentional
  const initialStart = React.useMemo(() => {
    if (defaults?.startsAt) return isoToLocalInput(defaults.startsAt);
    if (initialDate) return `${initialDate}T09:00`;
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
    return isoToLocalInput(d.toISOString());
  }, [defaults?.startsAt, initialDate]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memo intentional
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

  // Overlap warning: any other non-cancelled/non-completed event in the
  // same warehouse whose [start, end] window intersects ours triggers
  // an inline banner. Open-ended events (endsAt null) collapse to a
  // single point at startsAt for comparison purposes. We deliberately
  // do NOT block submit — overlaps are sometimes intentional (two crew
  // running parallel jobs at the same dock).
  const conflicts = React.useMemo(() => {
    if (!warehouseId || !startsAtLocal) return [] as ConflictCandidate[];
    const myStart = new Date(startsAtLocal).getTime();
    if (!Number.isFinite(myStart)) return [];
    const myEnd = endsAtLocal ? new Date(endsAtLocal).getTime() : myStart;
    if (!Number.isFinite(myEnd) || myEnd < myStart) return [];
    return conflictCandidates.filter((c) => {
      if (c.warehouseId !== warehouseId) return false;
      const cStart = new Date(c.startsAt).getTime();
      const cEnd = c.endsAt ? new Date(c.endsAt).getTime() : cStart;
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd)) return false;
      // Standard interval intersection: A starts before B ends AND
      // B starts before A ends. Equal endpoints don't count (one
      // ends exactly when the other starts → no real overlap).
      return cStart < myEnd && myStart < cEnd;
    });
  }, [conflictCandidates, warehouseId, startsAtLocal, endsAtLocal]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!warehouseId) {
      toast.error('Pick a warehouse. Events are scoped to warehouse staff.');
      return;
    }
    setBusy(true);

    // Validate bundle linkage: if any of the 3 are set, all must be.
    const wantsBundle = Boolean(bundleId);
    const qty = Number(bundleQuantity);
    if (wantsBundle && (!bundleWarehouseId || !Number.isFinite(qty) || qty <= 0)) {
      toast.error('Bundle linkage needs a quantity and a warehouse together.');
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
      toast.success(isEdit ? 'Event updated.' : 'Event created.');
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
      toast.success('Event deleted.');
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
            min={MIN_LOCAL_DATETIME}
            max={MAX_LOCAL_DATETIME}
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
            min={startsAtLocal || MIN_LOCAL_DATETIME}
            max={MAX_LOCAL_DATETIME}
          />
        </div>
      </div>

      {conflicts.length > 0 ? (
        <div className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200 rounded-md border px-3 py-2 text-[11.5px]">
          <p className="font-medium">
            Heads up — {conflicts.length} overlapping event
            {conflicts.length === 1 ? '' : 's'} in this warehouse:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {conflicts.slice(0, 5).map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.title}</span>{' '}
                <span className="opacity-70">
                  ({new Date(c.startsAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {c.requesterName ? ` · ${c.requesterName}` : ''})
                </span>
              </li>
            ))}
            {conflicts.length > 5 ? (
              <li className="opacity-70">+{conflicts.length - 5} more</li>
            ) : null}
          </ul>
          <p className="mt-1 opacity-80">
            You can still save — overlaps are sometimes intentional.
          </p>
        </div>
      ) : null}

      {/*
        all_day is *decorative*: the calendar cell + detail page hide the
        time portion when this is checked, but starts_at / ends_at still
        store and respect the real timestamps. If you need to reschedule
        an all-day reminder, just edit the date; the time portion is
        ignored at render time.

        Recurring events are NOT supported by the data model — every row
        is a single occurrence. If a job repeats weekly, the user has to
        clone the event manually (right now we don't expose a "duplicate"
        action; it's on the polish list).
      */}
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
        description={
          defaults?.bundleAlreadyDistributed
            ? "Removes the event from the calendar. The bundle distribution it already fired stays on record — deleting the event won't un-distribute kits."
            : "Removes the event from the calendar. If a bundle is linked but not yet distributed, the auto-distribute trigger is canceled (you can still fire it manually from the bundle page). This cannot be undone."
        }
        confirmLabel="Delete event"
        pending={busy}
        onConfirm={confirmDelete}
      />
    </form>
  );
}
