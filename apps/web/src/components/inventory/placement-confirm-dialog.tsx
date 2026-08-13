'use client';

import type { BookCrateChangeItem } from '@stockpilot/core';
import { summarizeBookCrateChanges } from '@stockpilot/core';
import { AlertTriangle, Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * ONE confirmation for a put-away, however many questions it has to ask.
 *
 * A single placement can raise two of them at once — "this rack does not exist
 * yet, create it?" (the 2026-07-23 typo guard) and "this book is recorded in
 * Blue 4, overwrite that?" (the book-crate gate). Asked separately they are two
 * near-identical amber panels in a row, and the second one arrives AFTER the
 * user already committed to the first, which trains people to click through
 * both. So they are one dialog with one decision: everything that is about to
 * happen, then Go back / Continue.
 *
 * Semantics are a real nested dialog, not a panel with role="alertdialog"
 * painted on: focus is trapped here while it is open, Escape dismisses only
 * this step (the form underneath keeps every value the user typed), and focus
 * returns to where it came from on close. `role="alertdialog"` on the content
 * is what tells a screen reader this one interrupts rather than informs.
 */
export interface PlacementConfirmContent {
  title: string;
  /** Lead paragraph. Also the dialog's accessible description. */
  message: string;
  /**
   * Existing near-match labels from `describeNewRackPlacement` — "Did you mean
   * 10-A?". Rendered as one-tap alternatives that place into the EXISTING
   * location and create nothing.
   */
  suggestions?: string[];
  /**
   * Field-level crate lines for a SINGLE title ("Crate number will change from
   * 4 to 7."). Built by describeBookCrateChange.
   */
  crateLines?: string[];
  /**
   * The same question for a BULK selection, already aggregated — one summary
   * for 200 books, never 200 dialogs.
   */
  crateItems?: BookCrateChangeItem[];
  /** Anything else worth saying before committing (split stock, mixed types). */
  notices?: string[];
  /** "Create and place" when a location will be minted, else "Continue placement". */
  confirmLabel: string;
}

export function PlacementConfirmDialog({
  open,
  content,
  submitting,
  onCancel,
  onConfirm,
  onUseSuggestion,
}: {
  open: boolean;
  content: PlacementConfirmContent | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onUseSuggestion?: (label: string) => void;
}) {
  if (!content) return null;

  const summary =
    content.crateItems && content.crateItems.length > 0
      ? summarizeBookCrateChanges(content.crateItems)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While the placement is in flight, swallow Escape / overlay clicks:
        // a half-closed confirmation over an in-flight write is how a
        // double-submit starts.
        if (submitting) return;
        if (!next) onCancel();
      }}
    >
      <DialogContent role="alertdialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-amber-600 dark:text-amber-500 size-4 shrink-0" />
            {content.title}
          </DialogTitle>
          <DialogDescription>{content.message}</DialogDescription>
        </DialogHeader>

        {content.crateLines && content.crateLines.length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {content.crateLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        {summary && (
          <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p>
              {summary.total} {summary.total === 1 ? 'title' : 'titles'} will be recorded in{' '}
              <span className="font-medium">{summary.nextLabel ?? 'no crate'}</span>:
            </p>
            <ul className="text-muted-foreground space-y-0.5">
              {summary.groups.map((g) => (
                <li key={g.currentLabel ?? '__none__'}>
                  {g.count} {g.count === 1 ? 'title' : 'titles'}{' '}
                  {g.currentLabel ? (
                    <>
                      now in <span className="text-foreground font-medium">{g.currentLabel}</span>
                    </>
                  ) : (
                    'with no crate recorded'
                  )}
                </li>
              ))}
            </ul>
            {/* THE RACK CONSEQUENCE, inside the same amber panel as the crate
                change it rides with. It is not a separate question — the
                operator answers the crate, and this is the rest of what
                answering it does. Server-derived (only the gate has read the
                holdings) and deduped by summarizeBookCrateChanges, so 200 books
                off one rack read as one sentence.

                Rendered at full contrast rather than muted: a rack a human
                typed by hand is about to be erased, which is the loudest thing
                on this panel, not a footnote to the group counts. */}
            {summary.rackLines.length > 0 && (
              <ul className="space-y-0.5 border-t border-amber-500/30 pt-1.5 font-medium">
                {summary.rackLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {content.notices && content.notices.length > 0 && (
          <ul className="text-muted-foreground space-y-1 text-sm">
            {content.notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {content.suggestions && content.suggestions.length > 0 && onUseSuggestion && (
          <div className="flex flex-wrap gap-2">
            {content.suggestions.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => onUseSuggestion(s)}
              >
                Use {s} instead
              </Button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Go back
          </Button>
          {/* The label stays put while the write is in flight. A button whose
              accessible name is replaced by a spinner is unfindable to a
              screen reader — and to anyone re-reading what they just agreed to. */}
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {content.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
