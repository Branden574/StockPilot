// THE MANAGE ORDER ITEMS SELECTION (ordering visibility, design 8.2). Pure.
//
// Explicit ids only, kept across pages, each with what the review sheet lists
// for it (name, identifier, state), so nothing off the page is ever included
// without being shown. A group never stands for its members: a family is
// added only through its disclosure, record by record.
//
// The selection belongs to one organization and one user (its `scope`). A
// workspace switch re-renders the page through router.refresh(), which can
// keep client state, so the page passes its server-provided scope on every
// render and `inScope` empties a selection made under another one: the review
// never lists the previous organization's records and Hide selected never
// sends their ids (the server would refuse them anyway).

import { ORDER_CATALOG_VISIBILITY_MAX_ITEMS } from '@stockpilot/core';

export interface SelectedRecord {
  name: string;
  /** SKU, plus ISBN or barcode when there is one, as the row shows it. */
  identifier: string | null;
  /** Shown in Orders when it was selected (or as the last write left it). */
  visible: boolean;
}

export type SelectableRecord = SelectedRecord & { id: string };

export interface SelectionState {
  scope: string;
  entries: ReadonlyMap<string, SelectedRecord>;
}

/** The scope key: the organization and user the page was rendered for. */
export function selectionScope(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

export function emptySelection(scope: string): SelectionState {
  return { scope, entries: new Map() };
}

/** The selection for `scope`: unchanged when it already belongs to it,
 *  empty otherwise. */
export function inScope(state: SelectionState, scope: string): SelectionState {
  return state.scope === scope ? state : emptySelection(scope);
}

/** Adds records, never past ORDER_CATALOG_VISIBILITY_MAX_ITEMS. `capped`
 *  says that at least one record was left out because of the cap. */
export function select(
  state: SelectionState,
  records: readonly SelectableRecord[],
): { state: SelectionState; capped: boolean } {
  const next = new Map(state.entries);
  let capped = false;
  for (const r of records) {
    if (next.has(r.id)) {
      next.set(r.id, { name: r.name, identifier: r.identifier, visible: r.visible });
      continue;
    }
    if (next.size >= ORDER_CATALOG_VISIBILITY_MAX_ITEMS) {
      capped = true;
      continue;
    }
    next.set(r.id, { name: r.name, identifier: r.identifier, visible: r.visible });
  }
  return { state: { scope: state.scope, entries: next }, capped };
}

export function deselect(state: SelectionState, ids: readonly string[]): SelectionState {
  if (ids.length === 0) return state;
  const next = new Map(state.entries);
  for (const id of ids) next.delete(id);
  return { scope: state.scope, entries: next };
}

export function clearSelection(state: SelectionState): SelectionState {
  return emptySelection(state.scope);
}

export function selectedIds(state: SelectionState): string[] {
  return [...state.entries.keys()];
}

/** The header checkbox: how much of THIS page is selected. */
export function pageSelection(
  state: SelectionState,
  rows: readonly { id: string }[],
): 'none' | 'some' | 'all' {
  if (rows.length === 0) return 'none';
  const n = rows.filter((r) => state.entries.has(r.id)).length;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}

/**
 * After a write that saved: a bulk action clears the selection (design 8.2,
 * Saved); a single row's action keeps the selection and records the row's
 * new state, so the review never shows a stale one.
 */
export function afterWrite(
  state: SelectionState,
  write: { source: 'row' | 'bulk'; visible: boolean; ids: readonly string[] },
): SelectionState {
  if (write.source === 'bulk') return clearSelection(state);
  let changed = false;
  const next = new Map(state.entries);
  for (const id of write.ids) {
    const entry = next.get(id);
    if (entry && entry.visible !== write.visible) {
      next.set(id, { ...entry, visible: write.visible });
      changed = true;
    }
  }
  return changed ? { scope: state.scope, entries: next } : state;
}
