import type { ReactNode } from 'react';

/**
 * What DataListScreen (components/data-list-screen.tsx) shows besides its
 * rows, decided here so the node test runner can execute it (the screen
 * imports react-native).
 *
 *   loading                      a spinner, no list (unchanged)
 *   rows                         the rows
 *   no rows, read succeeded      the empty state: the screen's "No X yet."
 *   no rows, read failed         the failed-read state: the screen's words
 *                                for the failure, a warning glyph, its action
 *   no rows, read failed offline the same, with a no-connection glyph
 *   rows, a later read failed    the rows stay; `reloadNote`, when given, is
 *                                said above them
 *
 * A failed read never shows the empty copy (redesign defect D25: the drawer
 * lists said "No audit events yet." when the read had failed). The words are
 * always the screen's own; this file adds none.
 */
export interface DataListFailure {
  /** "Could not load audit events." */
  title: string;
  /** What to do next: "Check your connection and pull down to try again." */
  body: string;
  /** The read failed for want of a connection. */
  offline?: boolean;
  /** A control under the words ("Load again"). */
  action?: ReactNode;
  /** Said above rows an earlier read left on screen when this read failed. */
  reloadNote?: string;
}

export type DataListEmptyKind = 'empty' | 'failed' | 'offline';

/** Which panel stands in for the rows when there are none to show. */
export function dataListEmptyKind(failed: DataListFailure | null | undefined): DataListEmptyKind {
  if (!failed) return 'empty';
  return failed.offline ? 'offline' : 'failed';
}

/** The line said above rows that a failed reload left on screen, if any. */
export function dataListReloadNote(
  failed: DataListFailure | null | undefined,
  rowCount: number,
): string | null {
  if (!failed || rowCount <= 0) return null;
  const note = failed.reloadNote?.trim();
  return note ? note : null;
}
