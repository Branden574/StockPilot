'use client';

import type { BookCrateChangeItem, BookRackChangeItem } from '@stockpilot/core';
import { summarizeBookCrateChanges, summarizeBookRackClears } from '@stockpilot/core';
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
  /**
   * The RACK ERASURES this placement would perform — a SEPARATE question from
   * the crate one, with its own acknowledgement, and the only one that can be
   * asked when the crate does not change at all (the reported defect: crate
   * "Blue Shelf" into crate ('blue','Shelf') is the same crate, and rack 38-A
   * died anyway).
   *
   * Server-derived, always. Only a reader of the live holdings can tell a full
   * move from a split, so this dialog prints what it was told and never
   * predicts — predicting from a render-time snapshot is the mistake that
   * caused the original data loss.
   */
  rackItems?: BookRackChangeItem[];
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
  const rackSummary =
    content.rackItems && content.rackItems.length > 0
      ? summarizeBookRackClears(content.rackItems)
      : null;

  // ═══ THE RACK SENTENCE IS SAID ONCE, WHEREVER IT CAME FROM ═══
  //
  // One rack sentence can reach this component by three routes, and they are
  // deliberately the SAME STRING (`describeRackChange` composes all of them):
  // appended to `message` for the surfaces that render nothing else, carried as
  // DISCLOSURE on a crate change line, and carried as the answerable QUESTION on
  // a rack line. A placement that changes the crate AND erases the rack produces
  // all three at once.
  //
  // So they are merged and deduped into ONE list, and the duplicate comes out of
  // the LEAD PARAGRAPH, never out of the panel — a rack a human typed by hand
  // being erased is the loudest thing here, not a footnote. Only a sentence this
  // render is provably about to show below is removed, so this can shorten the
  // message and can never delete the sentence: no match, no change; nothing but
  // the sentence, no change.
  const rackLines = [...new Set([...(summary?.rackLines ?? []), ...(rackSummary?.lines ?? [])])];
  let message = content.message;
  for (const line of rackLines) {
    if (!message.includes(line)) continue;
    const without = message.replace(line, '').replace(/ {2,}/g, ' ').trim();
    if (without.length > 0) message = without;
  }

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
          <DialogDescription>{message}</DialogDescription>
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
            {rackLines.length > 0 && (
              <ul className="space-y-0.5 border-t border-amber-500/30 pt-1.5 font-medium">
                {rackLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* THE RACK QUESTION ON ITS OWN. Reached when the crate does not change
            — which is the case the whole rack channel exists for — so there is
            no crate panel above to ride in. Same amber weight: this is the
            erasure of a value a human typed, and the operator is being asked to
            approve it, not merely told.

            Rendered only when the crate panel is absent, because when both apply
            the sentences have already been merged into that one panel above and
            printing them twice is exactly what this component spent a commit
            fixing. */}
        {!summary && rackSummary && (
          <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">
              {rackSummary.total === 1
                ? 'This clears the rack recorded on this title:'
                : `This clears the rack recorded on ${rackSummary.total} titles:`}
            </p>
            <ul className="space-y-0.5">
              {rackSummary.groups.map((g) => (
                <li key={`${g.currentLabel}|${g.line}`}>
                  {g.line}
                  {rackSummary.total > 1 && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({g.count} {g.count === 1 ? 'title' : 'titles'})
                    </span>
                  )}
                </li>
              ))}
            </ul>
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
