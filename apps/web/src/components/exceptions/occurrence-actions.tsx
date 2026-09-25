'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { actOnExceptionAction } from '@/server/actions/exceptions';

import { EXCEPTION_ACKNOWLEDGE_HELP } from '@stockpilot/core';

const NOTE_MAX = 1000;

function newClientEventId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Acknowledge and Add note for one occurrence (F1-1). Rendered ONLY for a
 * reader the server said may act (the page decides; exception_occurrence_act
 * re-checks on every call). Nothing here resolves an exception: that happens
 * by itself once a check no longer finds the condition.
 *
 * THE REQUEST ID BELONGS TO THE PAYLOAD. A failed submission keeps its
 * clientEventId only for a resend of the SAME action and note, which the
 * server recognises as a replay (a request whose answer was lost adds nothing
 * the second time). Change the note or the button and it is a new request
 * with a new id. Reusing one id for everything (as this did) meant: the first
 * Acknowledge committed but its answer was lost, the reader typed a note and
 * pressed Acknowledge again, the server answered the replay "ok", the form
 * cleared, and the note was never stored. The server now also refuses a
 * reused id with a different payload (client_event_id_conflict); on that
 * answer the id is dropped so the next press is a fresh request.
 *
 * Failures show inline with role="alert" (recurring pattern #20).
 */
export function OccurrenceActions({
  occurrenceId,
  acknowledged,
}: {
  occurrenceId: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'acknowledge' | 'note' | null>(null);
  // The last submission that did not succeed: a resend of exactly it reuses
  // its id; anything else gets a new one. Read only in event handlers.
  const lastAttempt = React.useRef<{
    action: 'acknowledge' | 'note';
    note: string | null;
    id: string;
  } | null>(null);

  const trimmed = note.trim();
  const tooLong = Array.from(trimmed).length > NOTE_MAX;

  async function submit(action: 'acknowledge' | 'note') {
    if (pending !== null || tooLong) return;
    if (action === 'note' && trimmed === '') return;
    const payloadNote = trimmed || null;
    const last = lastAttempt.current;
    const clientEventId =
      last && last.action === action && last.note === payloadNote ? last.id : newClientEventId();
    lastAttempt.current = { action, note: payloadNote, id: clientEventId };
    setPending(action);
    setError(null);
    const res = await actOnExceptionAction(occurrenceId, {
      action,
      note: payloadNote,
      clientEventId,
    });
    setPending(null);
    if ('error' in res) {
      // A conflict means this id already stands for another request: never
      // send it again.
      if (res.error.reason === 'client_event_id_conflict') lastAttempt.current = null;
      setError(res.error.message);
      return;
    }
    lastAttempt.current = null;
    setNote('');
    router.refresh();
  }

  return (
    <section aria-label="Acknowledge or add a note" className="space-y-3">
      {!acknowledged ? (
        <p className="text-muted-foreground text-sm">{EXCEPTION_ACKNOWLEDGE_HELP}</p>
      ) : null}
      <div className="space-y-1">
        <label htmlFor="exception-note" className="text-sm font-medium">
          Note{!acknowledged ? ' (optional when acknowledging)' : ''}
        </label>
        <Textarea
          id="exception-note"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setError(null);
          }}
          rows={3}
          placeholder="What you checked or what you are doing about it"
          disabled={pending !== null}
        />
        <p className={tooLong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
          {Array.from(trimmed).length.toLocaleString('en-US')} / {NOTE_MAX.toLocaleString('en-US')}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!acknowledged ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void submit('acknowledge')}
            disabled={pending !== null || tooLong}
          >
            {pending === 'acknowledge' ? 'Acknowledging...' : 'Acknowledge'}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void submit('note')}
          disabled={pending !== null || tooLong || trimmed === ''}
        >
          {pending === 'note' ? 'Adding...' : 'Add note'}
        </Button>
      </div>
    </section>
  );
}
