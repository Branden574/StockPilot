'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatRelative } from '@/lib/utils';
import { addMaintenanceNoteAction } from '@/server/actions/maintenance-requests';

export interface MaintenanceNoteRow {
  id: string;
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

interface Props {
  requestId: string;
  /** Whether the CURRENT viewer holds maintenance_requests:manage. Internal
   *  notes are manage-only end to end (0314 RLS + MaintenanceRequestsService.
   *  addNote()/listNotes()) — a requester must never see this panel, not even
   *  an empty shell, so this is checked here too as a second, independent
   *  guard alongside the page's own gating (which never even fetches notes
   *  for a non-manager). */
  canManage: boolean;
  notes: MaintenanceNoteRow[];
  /** userId -> display name, for whichever accepted org members the caller
   *  already resolved (the same lookup that backs AssignOwnerSelect). A note
   *  whose author isn't in this map (e.g. a removed member) falls back to a
   *  generic label rather than a raw uuid. */
  authorNames: Record<string, string>;
  /** true once `notes.length` hit the service's 500-row cap
   *  (MaintenanceRequestsService.listNotes) — the list may not be complete. */
  truncated: boolean;
}

/**
 * Internal StockPilot notes — never visible to the requester, never synced
 * anywhere (brief §5/§23). These are StockPilot-internal coordination notes,
 * NOT a Zendesk comment thread; the panel's own copy says so explicitly so
 * nothing here is ever mistaken for ticket conversation.
 */
export function MaintenanceNotesPanel({ requestId, canManage, notes, authorNames, truncated }: Props) {
  const router = useRouter();
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!canManage) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    const res = await addMaintenanceNoteAction(requestId, text);
    setSubmitting(false);
    if ('error' in res) {
      setError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setBody('');
    router.refresh();
  }

  return (
    // The aside card look (DESIGN-SPEC 6.7): a titled card; each note a
    // hairline-separated row with its author and time quiet under it.
    <DetailSection
      title="Internal StockPilot notes"
      aria-label="Internal StockPilot notes"
      bodyClassName="space-y-3"
    >
      <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">
        Visible only to StockPilot coordinators. Internal StockPilot notes only — never sent to the
        requester, never part of a Zendesk ticket thread, and never included in any email.
      </p>

      {notes.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No internal notes yet.</p>
      ) : (
        <ul className="divide-border border-border divide-y border-y">
          {notes.map((n) => (
            <li key={n.id} className="py-2.5">
              <p className="whitespace-pre-wrap text-[13.5px] leading-[20.25px] [overflow-wrap:anywhere]">
                {n.body}
              </p>
              {/* The relative time is rendered on the server and hydrated a
                  minute later: tolerate the drift instead of React error #418. */}
              <p className="text-muted-foreground mt-0.5 text-[12px]" suppressHydrationWarning>
                {(n.authorUserId && authorNames[n.authorUserId]) || 'StockPilot coordinator'} ·{' '}
                {formatRelative(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="text-muted-foreground text-[12px]">
          Showing the most recent 500 notes. Older notes are not shown.
        </p>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Add an internal note for other StockPilot coordinators..."
          aria-label="New internal note"
          disabled={submitting}
        />
        {error ? (
          <p role="alert" className="text-destructive text-[12.5px]">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="outline" size="sm" disabled={submitting || !body.trim()}>
          {submitting ? 'Adding...' : 'Add note'}
        </Button>
      </form>
    </DetailSection>
  );
}
