'use client';

import * as React from 'react';

import type { ZendeskComment, ZendeskTicket } from '@/server/connectors/zendesk/client';

import { Badge } from '@/components/ui/badge';

interface Props {
  ticket: ZendeskTicket | null;
  comments: ZendeskComment[];
  loading: boolean;
  error: string | null;
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

export function TicketDetail({ ticket, comments, loading, error }: Props) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="text-muted-foreground text-sm">Loading ticket…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive p-4 text-sm">
        {error}
      </div>
    );
  }

  if (!ticket) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Select a ticket to view the details.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="text-sm font-semibold">{ticket.subject}</h3>
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary shrink-0 text-xs hover:underline"
          >
            Open in Zendesk ↗
          </a>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="capitalize">
            {ticket.status}
          </Badge>
          {ticket.priority && (
            <Badge variant="outline" className="capitalize">
              {ticket.priority}
            </Badge>
          )}
        </div>
      </div>

      {/* Comment thread */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase tracking-wide opacity-60">
          Comments ({comments.length})
        </h4>
        {comments.length === 0 && (
          <p className="text-muted-foreground text-sm">No comments yet.</p>
        )}
        {comments.map((comment) => (
          <div
            key={comment.id}
            className="rounded-lg border p-3 text-sm space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Author #{comment.authorId ?? '?'}
              </span>
              <div className="flex items-center gap-1.5">
                {!comment.public && (
                  <Badge variant="outline" className="text-[10px]">
                    Internal
                  </Badge>
                )}
                <span className="text-muted-foreground text-xs">
                  {relativeTime(comment.createdAt)}
                </span>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
