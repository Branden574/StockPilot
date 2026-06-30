'use client';

import * as React from 'react';

import type { ZendeskComment, ZendeskTicket } from '@/server/connectors/zendesk/client';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

import { TicketDetail } from './ticket-detail';
import { TicketList } from './ticket-list';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------
type ConsoleState =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'reauth' }
  | { phase: 'error'; message: string }
  | { phase: 'connected' };

// ---------------------------------------------------------------------------
// AgentConsole
// ---------------------------------------------------------------------------
export function AgentConsole() {
  const [state, setState] = React.useState<ConsoleState>({ phase: 'loading' });
  const [tickets, setTickets] = React.useState<ZendeskTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [detailTicket, setDetailTicket] = React.useState<ZendeskTicket | null>(null);
  const [detailComments, setDetailComments] = React.useState<ZendeskComment[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [disconnecting, setDisconnecting] = React.useState(false);

  // Read URL params for post-OAuth feedback
  const [urlNote, setUrlNote] = React.useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      let hasParam = false;
      if (params.get('connected') === '1') {
        setUrlNote({ kind: 'success', message: 'Zendesk connected successfully.' });
        hasParam = true;
      } else if (params.get('error') === 'connect_failed') {
        setUrlNote({ kind: 'error', message: 'Failed to connect Zendesk — please try again.' });
        hasParam = true;
      }
      // Clean up so the banner doesn't reappear on refresh.
      if (hasParam) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  }, []);

  // On mount: check if the user has a Zendesk connection.
  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/v1/zendesk/me');
        if (cancelled) return;

        if (res.status === 401) {
          setState({ phase: 'reauth' });
          return;
        }

        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          if (body.error === 'not_connected') {
            setState({ phase: 'disconnected' });
            return;
          }
          setState({ phase: 'error', message: body.error ?? 'Failed to load Zendesk status.' });
          return;
        }

        const body = (await res.json()) as { connected: boolean };
        if (!body.connected) {
          setState({ phase: 'disconnected' });
          return;
        }

        setState({ phase: 'connected' });
      } catch {
        if (!cancelled) {
          setState({ phase: 'error', message: 'Network error — could not reach the server.' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // When connected, fetch the ticket list.
  React.useEffect(() => {
    if (state.phase !== 'connected') return;
    let cancelled = false;

    (async () => {
      setTicketsLoading(true);
      try {
        const res = await fetch('/api/v1/zendesk/me/tickets?view=assigned');
        if (cancelled) return;

        if (res.status === 401) {
          setState({ phase: 'reauth' });
          return;
        }

        if (!res.ok) return;

        const body = (await res.json()) as { tickets: ZendeskTicket[] };
        if (!cancelled) setTickets(body.tickets ?? []);
      } finally {
        if (!cancelled) setTicketsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.phase]);

  // When a ticket row is selected, fetch the detail.
  async function handleSelectTicket(id: number) {
    setSelectedId(id);
    setDetailTicket(null);
    setDetailComments([]);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const res = await fetch(`/api/v1/zendesk/me/tickets/${id}`);

      if (res.status === 401) {
        setState({ phase: 'reauth' });
        return;
      }

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setDetailError(body.error ?? 'Could not load ticket.');
        return;
      }

      const body = (await res.json()) as {
        ticket: ZendeskTicket;
        comments: ZendeskComment[];
      };
      setDetailTicket(body.ticket);
      setDetailComments(body.comments ?? []);
    } catch {
      setDetailError('Network error — could not load ticket.');
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/v1/zendesk/me/disconnect', { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to disconnect Zendesk — please try again.');
        return;
      }
      setState({ phase: 'disconnected' });
      setTickets([]);
      setSelectedId(null);
      setDetailTicket(null);
      setDetailComments([]);
    } catch {
      toast.error('Network error — could not disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (state.phase === 'loading') {
    return (
      <div className="flex h-24 items-center justify-center">
        <span className="text-muted-foreground text-sm">Loading…</span>
      </div>
    );
  }

  if (state.phase === 'disconnected' || state.phase === 'reauth') {
    return (
      <div className="space-y-3">
        {urlNote && (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              urlNote.kind === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
                : 'border-destructive/20 bg-destructive/5 text-destructive'
            }`}
          >
            {urlNote.message}
          </p>
        )}
        {state.phase === 'reauth' && (
          <p className="text-muted-foreground text-sm">
            Your Zendesk session expired. Please reconnect.
          </p>
        )}
        <div className="rounded-lg border p-4 text-sm">
          <p className="text-muted-foreground mb-3">
            Connect your personal Zendesk account to view and manage your assigned
            tickets without leaving StockPilot.
          </p>
          {/* MUST be a real navigation — this route 302-redirects the browser to
              Zendesk's OAuth consent page. A fetch() would follow the redirect
              silently and never send the user to Zendesk. */}
          <a
            href="/api/v1/zendesk/oauth/start"
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1"
          >
            Connect my Zendesk
          </a>
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="text-destructive text-sm">{state.message}</p>
    );
  }

  // phase === 'connected'
  return (
    <div className="space-y-2">
      {urlNote?.kind === 'success' && (
        <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          {urlNote.message}
        </p>
      )}

      {/* Disconnect affordance */}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disconnecting}
          onClick={handleDisconnect}
        >
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>

      {/* Master / detail layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Ticket list */}
        <div className="bg-card rounded-xl border">
          <div className="border-b px-4 py-2.5">
            <span className="text-sm font-medium">My assigned tickets</span>
          </div>
          {ticketsLoading ? (
            <div className="flex h-24 items-center justify-center">
              <span className="text-muted-foreground text-sm">Loading tickets…</span>
            </div>
          ) : (
            <TicketList
              tickets={tickets}
              selectedId={selectedId}
              onSelect={handleSelectTicket}
            />
          )}
        </div>

        {/* Ticket detail */}
        <div className="bg-card rounded-xl border">
          <div className="border-b px-4 py-2.5">
            <span className="text-sm font-medium">
              {detailTicket ? detailTicket.subject : 'Ticket detail'}
            </span>
          </div>
          <TicketDetail
            ticket={detailTicket}
            comments={detailComments}
            loading={detailLoading}
            error={detailError}
          />
        </div>
      </div>
    </div>
  );
}
