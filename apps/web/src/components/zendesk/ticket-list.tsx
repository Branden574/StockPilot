'use client';

import * as React from 'react';

import type { ZendeskTicket } from '@/server/connectors/zendesk/client';

import { Badge } from '@/components/ui/badge';

interface Props {
  tickets: ZendeskTicket[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function statusVariant(
  status: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' {
  switch (status) {
    case 'open':
      return 'default';
    case 'pending':
      return 'warning';
    case 'solved':
    case 'closed':
      return 'success';
    default:
      return 'secondary';
  }
}

function priorityVariant(
  priority: string | null,
): 'default' | 'secondary' | 'warning' | 'destructive' | 'outline' {
  switch (priority) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'warning';
    case 'normal':
      return 'secondary';
    case 'low':
      return 'outline';
    default:
      return 'outline';
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TicketList({ tickets, selectedId, onSelect }: Props) {
  if (tickets.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No tickets found.
      </p>
    );
  }

  return (
    <ul className="divide-border divide-y">
      {tickets.map((ticket) => (
        <li
          key={ticket.id}
          className={`hover:bg-muted/40 cursor-pointer px-4 py-3 transition-colors ${
            selectedId === ticket.id ? 'bg-muted/60' : ''
          }`}
          onClick={() => onSelect(ticket.id)}
          role="button"
          aria-pressed={selectedId === ticket.id}
        >
          <div className="flex min-w-0 items-start justify-between gap-2">
            <p className="truncate text-sm font-medium">{ticket.subject}</p>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {relativeTime(ticket.updatedAt)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={statusVariant(ticket.status)} className="capitalize">
              {ticket.status}
            </Badge>
            {ticket.priority && (
              <Badge
                variant={priorityVariant(ticket.priority)}
                className="capitalize"
              >
                {ticket.priority}
              </Badge>
            )}
            {ticket.requesterId && (
              <span className="text-muted-foreground text-xs">
                #{ticket.requesterId}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
