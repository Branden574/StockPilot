'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { updateSupportTicketAction } from '@/server/actions/support-tickets';

import type { SupportTicketRow, TicketPriority, TicketStatus } from '@/server/services/support-tickets';

// UI option lists (local copy — the canonical enums live in the server-only
// service, which a client component can't import as values).
const STATUSES: TicketStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};
const PRIORITY_BADGE: Record<TicketPriority, 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  urgent: 'destructive',
  high: 'warning',
  normal: 'secondary',
  low: 'outline',
};
const FILTERS: Array<{ key: string; label: string; match: (t: SupportTicketRow) => boolean }> = [
  { key: 'open', label: 'Open', match: (t) => t.status === 'open' || t.status === 'in_progress' },
  { key: 'resolved', label: 'Resolved', match: (t) => t.status === 'resolved' },
  { key: 'closed', label: 'Closed', match: (t) => t.status === 'closed' },
  { key: 'all', label: 'All', match: () => true },
];

const selectClass =
  'border-border bg-background h-9 rounded-md border px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function SupportTriage({ tickets }: { tickets: SupportTicketRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState('open');
  const [openId, setOpenId] = React.useState<string | null>(null);

  const active = FILTERS.find((f) => f.key === filter);
  const visible = active ? tickets.filter(active.match) : tickets;

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = tickets.filter(f.match).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                'rounded-full border px-3 py-1 text-[12.5px] transition-colors ' +
                (filter === f.key
                  ? 'border-primary bg-foreground text-background'
                  : 'border-border text-[var(--ed-ink-3)] hover:bg-muted')
              }
            >
              {f.label} <span className="tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tickets here. 🎉</p>
      ) : (
        <div className="space-y-2">
          {visible.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              expanded={openId === t.id}
              onToggle={() => setOpenId((id) => (id === t.id ? null : t.id))}
              onSaved={() => router.refresh()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket,
  expanded,
  onToggle,
  onSaved,
}: {
  ticket: SupportTicketRow;
  expanded: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = React.useState<TicketStatus>(ticket.status);
  const [priority, setPriority] = React.useState<TicketPriority>(ticket.priority);
  const [notes, setNotes] = React.useState(ticket.adminNotes ?? '');
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    const res = await updateSupportTicketAction({ id: ticket.id, status, priority, adminNotes: notes });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.success('Ticket updated.');
    onSaved();
  }

  return (
    <div className="border-border bg-card rounded-lg border">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <Badge variant={PRIORITY_BADGE[ticket.priority]}>{ticket.priority}</Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{ticket.subject}</div>
          <div className="text-muted-foreground truncate text-xs">
            {ticket.email} · {ticket.category} ·{' '}
            {new Date(ticket.createdAt).toLocaleDateString()}
          </div>
        </div>
        <Badge variant={ticket.status === 'open' ? 'success' : 'outline'}>
          {STATUS_LABEL[ticket.status]}
        </Badge>
      </button>

      {expanded && (
        <div className="border-border space-y-4 border-t px-4 py-4">
          <div>
            <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
              Message {ticket.name ? `· from ${ticket.name}` : ''}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{ticket.message}</p>
            {ticket.pageUrl && (
              <p className="text-muted-foreground mt-2 break-all text-xs">
                Reported from: {ticket.pageUrl}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ed-ink-4)]">
              Status
              <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ed-ink-4)]">
              Priority
              <select className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <a
              href={`mailto:${ticket.email}?subject=Re: ${encodeURIComponent(ticket.subject)}`}
              className="border-border hover:bg-muted ml-auto rounded-md border px-3 py-2 text-[13px] font-medium"
            >
              Reply by email
            </a>
          </div>

          <div>
            <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">
              Internal notes
            </div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} placeholder="Triage notes (not shown to the reporter)" />
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
