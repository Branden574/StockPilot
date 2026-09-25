'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  RECOUNT_COUNTS_TOTAL_COPY,
  recountResultSummary,
  type RecountResultSummary,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listCountAssigneesAction, startRecountAction } from '@/server/actions/exceptions';

const UNASSIGNED = '__unassigned';

type Members =
  | { kind: 'loading' }
  | { kind: 'ready'; list: Array<{ id: string; name: string }> }
  | { kind: 'failed'; message: string };

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** What a request asks for, for deciding whether a retry is the SAME
 *  request. The database hashes the sorted ids (not the assignee), so a
 *  key stands for exactly this selection. */
function selectionSignature(occurrenceIds: readonly string[], itemIds: readonly string[]): string {
  return `${[...occurrenceIds].sort().join(',')}|${[...itemIds].sort().join(',')}`;
}

export interface RecountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Recount 3 exceptions", "Count this item", ... */
  title: string;
  occurrenceIds: readonly string[];
  itemIds?: readonly string[];
  /** The caller is still working out what to send (Count this item reads the
   *  item's open exceptions first): Start is disabled meanwhile. */
  preparing?: boolean;
  /** A sentence about the selection (e.g. the exceptions could not be read,
   *  so the count will not be linked to them). */
  note?: string | null;
  /** Why this recount cannot be started at all; Start is not offered. */
  blocked?: string | null;
  /** The org's time zone, for "open since" in the result. */
  timeZone?: string;
  /** Called once a recount was started (or linked), when the panel is
   *  closed. */
  onFinished?: () => void;
}

/**
 * THE RECOUNT DIALOG (F1-2), for the Exceptions list ("Recount selected"),
 * one exception's page and the item page ("Count this item").
 *
 * It says what a count covers (core RECOUNT_COUNTS_TOTAL_COPY), offers
 * "Assign to" from the member source every count assignee picker uses
 * (count-assignees.ts, loaded when the dialog opens), and starts ONE recount
 * through startRecountAction, the service the phone reaches through
 * POST /api/v1/exceptions/recount.
 *
 * ONE COUNT, EVEN WHEN SENT TWICE. The idempotency key belongs to the
 * selection: it is minted once and reused for every send of the same
 * selection while the dialog is open, so a double click, or a retry after a
 * lost answer or a retryable refusal, returns the first count instead of
 * starting a second. A key the server says stands for another selection
 * (idempotency_conflict) is dropped.
 *
 * Then the result panel, worded by core recountResultSummary: Started CC-...,
 * Already being counted in CC-..., linked, and Skipped. Failures show inline
 * with role="alert" (pattern #20), with Try again when the server says it is
 * safe.
 */
export function RecountDialog(props: RecountDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <RecountDialogBody {...props} /> : null}
    </Dialog>
  );
}

function RecountDialogBody({
  onOpenChange,
  title,
  occurrenceIds,
  itemIds = [],
  preparing = false,
  note = null,
  blocked = null,
  timeZone,
  onFinished,
}: RecountDialogProps) {
  const router = useRouter();
  const [members, setMembers] = React.useState<Members>({ kind: 'loading' });
  const [membersNonce, setMembersNonce] = React.useState(0);
  const [assignee, setAssignee] = React.useState<string>(UNASSIGNED);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; retryable: boolean } | null>(null);
  const [summary, setSummary] = React.useState<RecountResultSummary | null>(null);
  // The key for THIS selection, reused on every send of it. Read and written
  // only in the submit handler.
  const keyRef = React.useRef<{ signature: string; key: string } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void listCountAssigneesAction().then((res) => {
      if (cancelled) return;
      setMembers(
        'error' in res
          ? { kind: 'failed', message: res.error.message }
          : { kind: 'ready', list: res.members },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [membersNonce]);

  const nothingSelected = occurrenceIds.length === 0 && itemIds.length === 0;
  const canSubmit = !pending && !preparing && !blocked && !nothingSelected;

  async function submit() {
    if (!canSubmit) return;
    const signature = selectionSignature(occurrenceIds, itemIds);
    if (keyRef.current?.signature !== signature) {
      keyRef.current = { signature, key: newIdempotencyKey() };
    }
    const idempotencyKey = keyRef.current.key;
    setPending(true);
    setError(null);
    const assignedTo = assignee === UNASSIGNED ? null : assignee;
    const res = await startRecountAction({
      occurrenceIds: [...occurrenceIds],
      itemIds: [...itemIds],
      assignedTo,
      idempotencyKey,
    });
    setPending(false);
    if ('error' in res) {
      // The key stands for another selection: never send it again.
      if (res.error.reason === 'idempotency_conflict') keyRef.current = null;
      setError({ message: res.error.message, retryable: res.error.retryable === true });
      return;
    }
    const assigneeLabel =
      res.result.assignedTo && members.kind === 'ready'
        ? (members.list.find((m) => m.id === res.result.assignedTo)?.name ?? null)
        : null;
    setSummary(recountResultSummary(res.result, { timeZone, assigneeLabel }));
    router.refresh();
  }

  function finish() {
    onOpenChange(false);
    onFinished?.();
  }

  if (summary) {
    return (
      <DialogContent className="max-w-lg" data-testid="recount-result">
        <DialogHeader>
          <DialogTitle>Recount</DialogTitle>
        </DialogHeader>
        <RecountResultPanel summary={summary} />
        <DialogFooter>
          <Button onClick={finish}>Done</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      className="max-w-lg"
      onInteractOutside={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{RECOUNT_COUNTS_TOTAL_COPY}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          A recount is an ordinary count. It changes no stock until a manager posts it, and the
          system then checks these exceptions again.
        </p>
        {preparing ? (
          <p className="text-muted-foreground flex items-center gap-2" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Checking this item’s open exceptions...
          </p>
        ) : null}
        {note ? <p className="text-muted-foreground">{note}</p> : null}

        {blocked ? (
          <p className="text-muted-foreground" data-testid="recount-blocked">
            {blocked}
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="recount-assignee">
              Assign to
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            {members.kind === 'loading' ? (
              <p className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Loading team members...
              </p>
            ) : members.kind === 'failed' ? (
              <div className="space-y-1" data-testid="recount-members-failed">
                <p className="text-muted-foreground text-xs">
                  Team members could not be loaded. You can start the recount unassigned and assign
                  it from the count.
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    setMembers({ kind: 'loading' });
                    setMembersNonce((n) => n + 1);
                  }}
                >
                  Try loading them again
                </Button>
              </div>
            ) : (
              <>
                <Select value={assignee} onValueChange={setAssignee} disabled={pending}>
                  <SelectTrigger id="recount-assignee">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {members.list.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  The assignee gets a notification to start the count.
                </p>
              </>
            )}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
        </Button>
        {blocked ? null : (
          <Button onClick={() => void submit()} disabled={!canSubmit} variant="gradient">
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-label="Starting" />
            ) : error?.retryable ? (
              'Try again'
            ) : (
              'Start recount'
            )}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/** The three groups of a recount's result, with links to the counts. */
export function RecountResultPanel({ summary }: { summary: RecountResultSummary }) {
  return (
    <div className="space-y-3 text-sm" aria-live="polite">
      {summary.started ? (
        <div className="space-y-1" data-testid="recount-started">
          <p className="font-medium">{summary.started.text}</p>
          {summary.assignment ? <p className="text-muted-foreground">{summary.assignment}</p> : null}
          <Link
            href={`/dashboard/cycle-counts/${summary.started.cycleCountId}`}
            className="text-primary text-sm hover:underline"
          >
            Open the count
          </Link>
        </div>
      ) : null}
      {summary.alreadyCounting.length > 0 ? (
        <ul className="space-y-1" data-testid="recount-already-counting">
          {summary.alreadyCounting.map((a) => (
            <li key={a.cycleCountId}>
              <Link href={`/dashboard/cycle-counts/${a.cycleCountId}`} className="hover:underline">
                {a.text}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.skipped.length > 0 ? (
        <ul className="text-muted-foreground space-y-1" data-testid="recount-skipped">
          {summary.skipped.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      {summary.nothing ? <p className="text-muted-foreground">{summary.nothing}</p> : null}
    </div>
  );
}
