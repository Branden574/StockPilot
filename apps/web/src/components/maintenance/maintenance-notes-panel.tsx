'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

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
    <section aria-label="Internal StockPilot notes" className="space-y-3 rounded-xl border bg-card p-4 text-xs">
      <div>
        <h2 className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">
          Internal StockPilot notes
        </h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Visible only to StockPilot coordinators. Internal StockPilot notes only — never sent to the requester,
          never part of a Zendesk ticket thread, and never included in any email.
        </p>
      </div>

      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No internal notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md bg-muted/40 p-3">
              <p className="whitespace-pre-wrap text-sm">{n.body}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {(n.authorUserId && authorNames[n.authorUserId]) || 'StockPilot coordinator'} ·{' '}
                {formatRelative(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="text-[11px] text-muted-foreground">
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
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={submitting || !body.trim()}>
          {submitting ? 'Adding...' : 'Add note'}
        </Button>
      </form>
    </section>
  );
}
