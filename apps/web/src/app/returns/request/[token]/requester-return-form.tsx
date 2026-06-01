'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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

import type { ReturnableLine } from '@/server/services/returns';

const REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'overage', label: 'Too many / overage' },
  { value: 'end_of_year', label: 'End of year' },
  { value: 'other', label: 'Other' },
];

interface RequesterReturnFormProps {
  token: string;
  lines: ReturnableLine[];
  requesterName: string | null;
}

/**
 * Client form for the public requester return portal. Lets the requester check
 * the lines they want to return and pick a quantity (capped at the remaining-
 * returnable budget the server sent down) plus a reason. The server NEVER
 * trusts these values — it re-validates the token, line belonging, and the
 * durable budget on submit — but the UI caps the inputs so the common path
 * doesn't bounce off a 400.
 */
export function RequesterReturnForm({ token, lines, requesterName }: RequesterReturnFormProps) {
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [quantities, setQuantities] = React.useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.orderRequestLineId, l.quantityRemaining])),
  );
  const [reasonCode, setReasonCode] = React.useState<string>('');
  const [notes, setNotes] = React.useState('');
  // Honeypot — bound to an off-screen field; real users never touch it.
  const [hp, setHp] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);

  function toggle(lineId: string) {
    setSelected((prev) => ({ ...prev, [lineId]: !prev[lineId] }));
  }

  function setQty(line: ReturnableLine, raw: string) {
    const n = Math.floor(Number(raw));
    const clamped = Number.isFinite(n)
      ? Math.max(1, Math.min(line.quantityRemaining, n))
      : 1;
    setQuantities((prev) => ({ ...prev, [line.orderRequestLineId]: clamped }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const picked = lines.filter((l) => selected[l.orderRequestLineId]);
    if (picked.length === 0) {
      toast.error('Pick at least one item to return.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/returns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          reasonCode: reasonCode || undefined,
          notes: notes.trim() || undefined,
          hp,
          lines: picked.map((l) => ({
            orderRequestLineId: l.orderRequestLineId,
            quantity: quantities[l.orderRequestLineId] ?? l.quantityRemaining,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        toast.error(data.message ?? 'Could not submit your return. Please try again.');
        return;
      }
      setDone(true);
    } catch {
      toast.error('Could not submit your return. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="border-border bg-card rounded-2xl border p-6 text-center">
        <h2 className="font-display text-lg">Return request submitted</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Thanks{requesterName ? `, ${requesterName.split(' ')[0]}` : ''} — the
          warehouse team will review your request and follow up. You can close
          this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Honeypot — off-screen, never visible to real users. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
      >
        <label htmlFor="return-hp">Website</label>
        <input
          type="text"
          id="return-hp"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(e) => setHp(e.target.value)}
        />
      </div>

      <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
        <h2 className="font-display text-base font-semibold">Items to return</h2>
        <ul className="divide-border divide-y">
          {lines.map((line) => {
            const isSelected = Boolean(selected[line.orderRequestLineId]);
            return (
              <li key={line.orderRequestLineId} className="flex items-center gap-3 py-3">
                <input
                  type="checkbox"
                  id={`line-${line.orderRequestLineId}`}
                  checked={isSelected}
                  onChange={() => toggle(line.orderRequestLineId)}
                  className="h-4 w-4 shrink-0"
                />
                <label
                  htmlFor={`line-${line.orderRequestLineId}`}
                  className="min-w-0 flex-1 cursor-pointer"
                >
                  <div className="truncate text-sm font-medium">
                    {line.itemName ?? 'Item'}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {line.itemSku ? `${line.itemSku} · ` : ''}
                    {line.quantityRemaining} of {line.quantityFulfilled} returnable
                  </div>
                </label>
                {isSelected && (
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={line.quantityRemaining}
                    value={quantities[line.orderRequestLineId] ?? line.quantityRemaining}
                    onChange={(e) => setQty(line, e.target.value)}
                    className="w-20 shrink-0"
                    aria-label={`Quantity to return for ${line.itemName ?? 'item'}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-border bg-card space-y-4 rounded-2xl border p-5">
        <div className="space-y-1.5">
          <Label htmlFor="return-reason">Reason (optional)</Label>
          <Select value={reasonCode} onValueChange={setReasonCode}>
            <SelectTrigger id="return-reason">
              <SelectValue placeholder="Pick a reason" />
            </SelectTrigger>
            <SelectContent>
              {REASON_OPTIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="return-notes">Notes (optional)</Label>
          <Textarea
            id="return-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the warehouse should know about this return."
            rows={3}
            maxLength={2000}
            className="resize-none text-sm"
          />
        </div>
      </div>

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Submitting…' : 'Submit return request'}
      </Button>
    </form>
  );
}
