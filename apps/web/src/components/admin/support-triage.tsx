'use client';

import { ChevronRight, PartyPopper } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { FilterChip } from '@/components/patterns/chip';
import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { updateSupportTicketAction } from '@/server/actions/support-tickets';

import type {
  SupportTicketRow,
  TicketPriority,
  TicketStatus,
} from '@/server/services/support-tickets';

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
const PRIORITY_BADGE: Record<TicketPriority, 'destructive' | 'warning' | 'secondary' | 'outline'> =
  {
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

// The shared field recipe (32 px, stronger hairline, card fill, focus ring;
// 44 px with 16 px text below sm), kept on native selects so the form posts
// and keyboard use stay exactly as they were.
const selectClass =
  'bg-card h-8 rounded-md border border-line-strong px-2.5 text-[13px] text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-sm:h-11 max-sm:text-base';

/** One ticket's unsaved triage edits. */
interface TicketDraft {
  status: TicketStatus;
  priority: TicketPriority;
  notes: string;
}

function draftFrom(ticket: SupportTicketRow): TicketDraft {
  return { status: ticket.status, priority: ticket.priority, notes: ticket.adminNotes ?? '' };
}

function sameDraft(a: TicketDraft, b: TicketDraft): boolean {
  return a.status === b.status && a.priority === b.priority && a.notes === b.notes;
}

export function SupportTriage({
  tickets,
  attachmentUrls,
}: {
  tickets: SupportTicketRow[];
  /** ticketId → 1-hour signed URL for its screenshot (server-minted). */
  attachmentUrls?: Record<string, string>;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState('open');
  const [openId, setOpenId] = React.useState<string | null>(null);
  // Each card's edits live here, not in the card: switching the filter
  // unmounts the cards it hides, and their typed notes and picked status or
  // priority used to vanish with them (CONFLICTS D31). A ticket with no entry
  // shows what the server has; a successful save removes the entry it sent.
  const [drafts, setDrafts] = React.useState<Record<string, TicketDraft>>({});

  // After a save the server's values take over again: a draft left behind
  // would hide the saved (normalised) values and any later change from the
  // platform console twin, and a later Save would send its stale status and
  // priority back. The entry is dropped in the same transition as the refresh,
  // so the refreshed ticket replaces it in one commit. Edits typed while the
  // save was on its way differ from what was sent, so they stay as the draft.
  function dropSavedDraft(ticketId: string, sent: TicketDraft) {
    React.startTransition(() => {
      setDrafts((all) => {
        const current = all[ticketId];
        if (!current || !sameDraft(current, sent)) return all;
        const rest = { ...all };
        delete rest[ticketId];
        return rest;
      });
      router.refresh();
    });
  }

  const active = FILTERS.find((f) => f.key === filter);
  const visible = active ? tickets.filter(active.match) : tickets;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = tickets.filter(f.match).length;
          return (
            <FilterChip
              key={f.key}
              pressed={filter === f.key}
              count={count}
              size="md"
              onClick={() => setFilter(f.key)}
            >
              {/* The space keeps the button's name "Open 3", as before. */}
              {f.label}{' '}
            </FilterChip>
          );
        })}
      </div>

      {visible.length === 0 ? (
        // The words stay; the celebration emoji became an icon (owner rule:
        // no emojis in the interface).
        <StatePanel
          kind="empty"
          icon={PartyPopper}
          headingLevel={null}
          size="sm"
          title="No tickets here."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              attachmentUrl={attachmentUrls?.[t.id]}
              expanded={openId === t.id}
              onToggle={() => setOpenId((id) => (id === t.id ? null : t.id))}
              draft={drafts[t.id] ?? draftFrom(t)}
              onDraftChange={(next) => setDrafts((all) => ({ ...all, [t.id]: next }))}
              onSaved={(sent) => dropSavedDraft(t.id, sent)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket,
  attachmentUrl,
  expanded,
  onToggle,
  draft,
  onDraftChange,
  onSaved,
}: {
  ticket: SupportTicketRow;
  attachmentUrl?: string;
  expanded: boolean;
  onToggle: () => void;
  draft: TicketDraft;
  onDraftChange: (next: TicketDraft) => void;
  /** Called after a successful save with the values that were sent. */
  onSaved: (sent: TicketDraft) => void;
}) {
  const { status, priority, notes } = draft;
  const [busy, setBusy] = React.useState(false);
  // The day it came in is the viewer's; the server's zone (UTC) would print
  // the next day for an evening ticket (React error #418). Printed once hydrated.
  const hydrated = useHydrated();
  const panelId = `ticket-${ticket.id}-details`;
  const notesId = `ticket-${ticket.id}-notes`;

  async function save() {
    const sent = draft;
    setBusy(true);
    const res = await updateSupportTicketAction({
      id: ticket.id,
      status: sent.status,
      priority: sent.priority,
      adminNotes: sent.notes,
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.success('Ticket updated.');
    onSaved(sent);
  }

  return (
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        className="hover:bg-muted flex w-full items-center gap-3 px-[18px] py-3 text-left transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
      >
        <Badge variant={PRIORITY_BADGE[ticket.priority]}>{ticket.priority}</Badge>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-[13.5px] font-medium leading-5">
            {ticket.subject}
          </div>
          <div className="text-muted-foreground truncate text-[12.5px] leading-[18.75px]">
            {ticket.email} · {ticket.category}
            {hydrated ? ` · ${new Date(ticket.createdAt).toLocaleDateString()}` : null}
          </div>
        </div>
        <Badge variant={ticket.status === 'open' ? 'success' : 'outline'}>
          {STATUS_LABEL[ticket.status]}
        </Badge>
        <ChevronRight
          aria-hidden
          strokeWidth={1.8}
          className={cn(
            'text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div id={panelId} className="border-border space-y-4 border-t px-[18px] py-4">
          <div>
            <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              Message {ticket.name ? `· from ${ticket.name}` : ''}
            </div>
            <p className="text-foreground mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed">
              {ticket.message}
            </p>
            {ticket.pageUrl && (
              <p className="text-muted-foreground mt-2 break-all text-[12px]">
                Reported from: {ticket.pageUrl}
              </p>
            )}
            {attachmentUrl && (
              <p className="mt-2 text-[12px]">
                <a
                  href={attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground font-medium underline underline-offset-2 hover:opacity-80"
                >
                  Screenshot
                </a>{' '}
                <span className="text-muted-foreground">(link valid ~1 hour)</span>
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-muted-foreground flex flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.06em]">
              Status
              <select
                className={selectClass}
                value={status}
                onChange={(e) =>
                  onDraftChange({ ...draft, status: e.target.value as TicketStatus })
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted-foreground flex flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.06em]">
              Priority
              <select
                className={selectClass}
                value={priority}
                onChange={(e) =>
                  onDraftChange({ ...draft, priority: e.target.value as TicketPriority })
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <Button asChild variant="outline" className="ml-auto">
              <a href={`mailto:${ticket.email}?subject=Re: ${encodeURIComponent(ticket.subject)}`}>
                Reply by email
              </a>
            </Button>
          </div>

          <div>
            <label
              htmlFor={notesId}
              className="text-muted-foreground mb-1 block text-[11px] font-medium uppercase tracking-[0.06em]"
            >
              Internal notes
            </label>
            <Textarea
              id={notesId}
              value={notes}
              onChange={(e) => onDraftChange({ ...draft, notes: e.target.value })}
              rows={2}
              maxLength={4000}
              placeholder="Triage notes (not shown to the reporter)"
            />
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
