import { ORDER_CATALOG_VISIBILITY_MAX_ITEMS, ORDER_ITEMS_SELECTION_CAP_COPY } from '@stockpilot/core';

import type { PendingVisibilityBody } from './write';

/**
 * MANAGE ORDER ITEMS ON THE PHONE: THE SELECTION (ordering visibility, 0413;
 * design 8.2, 8.6). A module-level store (the pattern of use-count-selection
 * .ts, as a separate store), so the selection survives paging, the review
 * sheet and the family sheet, and is kept outside React where every rule is
 * tested.
 *
 * It holds explicit ids only (id to name, identifier and state), so the
 * review sheet can list every selected record, off-page ones included, and a
 * bulk action sends exactly those ids and nothing else.
 *
 * THE SCOPE RULE. It belongs to one (account, organization, account epoch).
 * The screen binds its scope on mount and focus; any other key clears the
 * selection, the review sheet and the kept operationId, the rule the
 * storefront session follows (session.ts open()). A read or a change for a
 * scope that is not the bound one sees and changes nothing, so a late
 * callback after a workspace switch cannot add the old organization's records
 * to the new one's selection, and Hide selected never sends them (the server
 * would refuse them anyway). Sign-out forgets everything from the place that
 * closes the storefront session (session.ts close()).
 *
 * No React here (the screen subscribes with useSyncExternalStore), so the
 * storefront session can import it with nothing else.
 */

export interface ManageScope {
  userId: string;
  orgId: string;
  /** account-epoch.ts accountEpoch(): a sign-out ends it. */
  epoch: number;
}

export function manageScopeKey(scope: ManageScope): string {
  return `${scope.userId.toLowerCase()}|${scope.orgId.toLowerCase()}|${scope.epoch}`;
}

/** One selected record, as the review sheet lists it. */
export interface SelectedRecord {
  id: string;
  name: string;
  identifier: string | null;
  /** Its state when it was picked (or as a saved change left it). */
  visible: boolean;
}

export interface SelectionSnapshot {
  /** The scope the selection belongs to; null before any is bound. */
  scopeKey: string | null;
  /** In the order they were picked. */
  records: readonly SelectedRecord[];
  ids: ReadonlySet<string>;
  /** The review sheet is open. */
  reviewOpen: boolean;
  /** The change last built and not settled (kept for its retries). */
  pending: PendingVisibilityBody | null;
}

export const EMPTY_SELECTION: SelectionSnapshot = Object.freeze({
  scopeKey: null,
  records: Object.freeze([]) as readonly SelectedRecord[],
  ids: new Set<string>(),
  reviewOpen: false,
  pending: null,
});

export interface SelectionStore {
  getSnapshot(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  /** The selection of `scope`, or the empty one while another is bound. */
  forScope(scope: ManageScope | null): SelectionSnapshot;
  /** The screen's scope: another key starts empty. */
  bindScope(scope: ManageScope): void;
  /** Tick or untick one record. Returns core's cap sentence when a tick
   *  would pass the cap (nothing changes), else null. */
  toggle(scope: ManageScope, record: SelectedRecord): string | null;
  /** Add records (a page, a family). All or nothing: the cap sentence when
   *  they do not all fit, else null. */
  add(scope: ManageScope, records: readonly SelectedRecord[]): string | null;
  remove(scope: ManageScope, ids: readonly string[]): void;
  /** Clear: the selection, the review sheet and the kept operation. */
  clear(scope: ManageScope): void;
  /** A saved change: the selected records it named take its state. */
  markVisible(scope: ManageScope, ids: readonly string[], visible: boolean): void;
  setReviewOpen(scope: ManageScope, open: boolean): void;
  setPending(scope: ManageScope, pending: PendingVisibilityBody | null): void;
  /** Sign-out: forget everything, the scope included. */
  reset(): void;
}

export function createSelectionStore(): SelectionStore {
  let snap: SelectionSnapshot = EMPTY_SELECTION;
  const listeners = new Set<() => void>();

  function publish(next: SelectionSnapshot) {
    snap = next;
    for (const l of listeners) l();
  }

  function withRecords(records: SelectedRecord[]): SelectionSnapshot {
    return { ...snap, records, ids: new Set(records.map((r) => r.id)) };
  }

  /** The call is for the bound scope (anything else changes nothing). */
  const bound = (scope: ManageScope) => snap.scopeKey !== null && snap.scopeKey === manageScopeKey(scope);

  const normal = (r: SelectedRecord): SelectedRecord => ({ ...r, id: r.id.toLowerCase() });

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    forScope(scope) {
      return scope !== null && bound(scope) ? snap : EMPTY_SELECTION;
    },
    bindScope(scope) {
      const key = manageScopeKey(scope);
      if (snap.scopeKey === key) return;
      publish({ ...EMPTY_SELECTION, scopeKey: key, ids: new Set() });
    },
    toggle(scope, record) {
      if (!bound(scope)) return null;
      const r = normal(record);
      if (snap.ids.has(r.id)) {
        publish(withRecords(snap.records.filter((x) => x.id !== r.id)));
        return null;
      }
      if (snap.records.length + 1 > ORDER_CATALOG_VISIBILITY_MAX_ITEMS) return ORDER_ITEMS_SELECTION_CAP_COPY;
      publish(withRecords([...snap.records, r]));
      return null;
    },
    add(scope, records) {
      if (!bound(scope)) return null;
      const fresh: SelectedRecord[] = [];
      const seen = new Set(snap.ids);
      for (const record of records) {
        const r = normal(record);
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        fresh.push(r);
      }
      if (fresh.length === 0) return null;
      if (snap.records.length + fresh.length > ORDER_CATALOG_VISIBILITY_MAX_ITEMS) return ORDER_ITEMS_SELECTION_CAP_COPY;
      publish(withRecords([...snap.records, ...fresh]));
      return null;
    },
    remove(scope, ids) {
      if (!bound(scope)) return;
      const drop = new Set(ids.map((id) => id.toLowerCase()));
      if (!snap.records.some((r) => drop.has(r.id))) return;
      publish(withRecords(snap.records.filter((r) => !drop.has(r.id))));
    },
    clear(scope) {
      if (!bound(scope)) return;
      if (snap.records.length === 0 && !snap.reviewOpen && snap.pending === null) return;
      publish({ ...EMPTY_SELECTION, scopeKey: snap.scopeKey, ids: new Set() });
    },
    markVisible(scope, ids, visible) {
      if (!bound(scope)) return;
      const named = new Set(ids.map((id) => id.toLowerCase()));
      if (!snap.records.some((r) => named.has(r.id) && r.visible !== visible)) return;
      publish(withRecords(snap.records.map((r) => (named.has(r.id) ? { ...r, visible } : r))));
    },
    setReviewOpen(scope, open) {
      if (!bound(scope) || snap.reviewOpen === open) return;
      publish({ ...snap, reviewOpen: open });
    },
    setPending(scope, pending) {
      if (!bound(scope) || snap.pending === pending) return;
      publish({ ...snap, pending });
    },
    reset() {
      if (snap === EMPTY_SELECTION) return;
      publish(EMPTY_SELECTION);
    },
  };
}

/** The one selection of this app run. */
export const orderCatalogSelection: SelectionStore = createSelectionStore();

/** Sign-out (the storefront session closing): forget everything. */
export function clearOrderCatalogSelection(): void {
  orderCatalogSelection.reset();
}
