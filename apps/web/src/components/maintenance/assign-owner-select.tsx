'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { assignMaintenanceOwnerAction } from '@/server/actions/maintenance-requests';

/** Radix Select rejects an empty-string item value, so the "no owner"
 *  option needs a real sentinel — translated back to `null` before it ever
 *  reaches the server action. */
const UNASSIGNED = '__unassigned__';

export interface MaintenanceOwnerOption {
  userId: string;
  name: string;
}

interface Props {
  requestId: string;
  currentOwnerUserId: string | null;
  members: MaintenanceOwnerOption[];
}

/**
 * manage-only affordance (the caller never mounts this for a non-manager —
 * assignMaintenanceOwnerAction/assignLocalOwner() are manage-gated at the
 * service too). "StockPilot owner" is a local StockPilot coordinator, never
 * a Zendesk assignee — brief §5 is explicit that the two must never be
 * conflated, so the label and helper text say so directly.
 */
export function AssignOwnerSelect({ requestId, currentOwnerUserId, members }: Props) {
  const router = useRouter();
  const [value, setValue] = React.useState(currentOwnerUserId ?? UNASSIGNED);
  const [pending, setPending] = React.useState(false);

  async function handleChange(next: string) {
    const previous = value;
    setValue(next);
    setPending(true);
    const res = await assignMaintenanceOwnerAction(requestId, next === UNASSIGNED ? null : next);
    setPending(false);
    if ('error' in res) {
      toast.error(res.error.message);
      setValue(previous);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <Label htmlFor="maintenance-owner" className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">
        StockPilot owner
      </Label>
      <Select value={value} onValueChange={(v) => void handleChange(v)} disabled={pending}>
        <SelectTrigger id="maintenance-owner">
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.userId} value={m.userId}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        Internal coordinator inside StockPilot. This is not a Zendesk assignment.
      </p>
    </div>
  );
}
