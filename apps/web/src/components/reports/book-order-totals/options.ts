import * as React from 'react';

import {
  bookReportCharterOptionLabels,
  parseBookOrderOptionsResponse,
  type BookOrderOptionsResponse,
} from '@stockpilot/core';

import { BOOK_REPORT_API } from './hrefs';

/**
 * The filter lists (the charters the caller may report on, and the
 * warehouses and categories that occur in the caller's own eligible order
 * lines), loaded ONCE per organization and person for the session and kept
 * only in memory: never persisted, and gone on a sign-out or an organization
 * switch (both reload the dashboard). A search, a sort or another page never
 * refetches them. They are never awaited with the numbers: a slow or failed
 * load leaves only the Charter, Warehouse and Category selects waiting or
 * disabled.
 *
 * Only a parsed answer for the SAME organization is kept; a failure (or an
 * aborted request) is not remembered, so the next mount or Retry asks again.
 *
 * The filter bar is the only loader. The Showing chips and "Books ordered by
 * charter" only READ what it loaded (subscribeBookReportOptions), for the
 * charter labels: until the lists arrive they name a charter from the
 * answer's own echo, so they never wait for the lists and never ask for them.
 */
const loaded = new Map<string, BookOrderOptionsResponse>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called whenever a list set is stored (or the store is reset). */
export function subscribeBookReportOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The lists the filter bar has loaded for this person, or null (not yet,
 *  or they failed). Never loads anything itself. Client components only;
 *  the server render (and hydration) always sees null. */
export function useLoadedBookReportOptions(
  organizationId: string,
  userId: string,
): BookOrderOptionsResponse | null {
  const key = bookReportOptionsKey(organizationId, userId);
  return React.useSyncExternalStore(
    subscribeBookReportOptions,
    () => loaded.get(key) ?? null,
    () => null,
  );
}

export function bookReportOptionsKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

export function cachedBookReportOptions(key: string): BookOrderOptionsResponse | null {
  return loaded.get(key) ?? null;
}

export async function loadBookReportOptions(
  organizationId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<BookOrderOptionsResponse> {
  const key = bookReportOptionsKey(organizationId, userId);
  const hit = loaded.get(key);
  if (hit) return hit;
  const res = await fetch(`${BOOK_REPORT_API}/options`, {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`options failed (${res.status})`);
  const answer = parseBookOrderOptionsResponse(await res.json());
  if (answer.organizationId !== organizationId) {
    throw new Error('options answered for another organization');
  }
  loaded.set(key, answer);
  notify();
  return answer;
}

type CharterLike = {
  id: string;
  name: string | null;
  code?: string | null;
  status?: string | null;
};

/**
 * One label per charter id for everything the page shows at once (the
 * select, the chips, the Showing line, the by-charter list), so a charter
 * reads the same everywhere, including core's id tie-break for two charters
 * with the same name and no code. Built over the lists' charters plus any
 * the page names that the lists do not carry (an echo, a by-charter row).
 */
export function bookReportCharterLabelsFor(
  options: BookOrderOptionsResponse | null,
  extra: ReadonlyArray<CharterLike | null | undefined> = [],
): Map<string, string> {
  const all: CharterLike[] = [...(options?.charters ?? [])];
  const seen = new Set(all.map((c) => c.id.toLowerCase()));
  for (const c of extra) {
    if (!c || seen.has(c.id.toLowerCase())) continue;
    seen.add(c.id.toLowerCase());
    all.push(c);
  }
  return bookReportCharterOptionLabels(all);
}

/** Tests only. */
export function __resetBookReportOptionsForTests(): void {
  loaded.clear();
  notify();
}
