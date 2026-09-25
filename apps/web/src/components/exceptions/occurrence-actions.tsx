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
 * One clientEventId per submission, kept after a failure so a retry of the
 * same submission is recognised as a replay (a request whose answer was lost
 * adds nothing the second time), and replaced once it succeeds.
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
  const [clientEventId, setClientEventId] = React.useState(newClientEventId);

  const trimmed = note.trim();
  const tooLong = Array.from(trimmed).length > NOTE_MAX;

  async function submit(action: 'acknowledge' | 'note') {
    if (pending !== null || tooLong) return;
    if (action === 'note' && trimmed === '') return;
    setPending(action);
    setError(null);
    const res = await actOnExceptionAction(occurrenceId, {
      action,
      note: trimmed || null,
      clientEventId,
    });
    setPending(null);
    if ('error' in res) {
      setError(res.error.message);
      return;
    }
    setNote('');
    setClientEventId(newClientEventId());
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
