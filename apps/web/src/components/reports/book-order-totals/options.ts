import { parseBookOrderOptionsResponse, type BookOrderOptionsResponse } from '@stockpilot/core';

import { BOOK_REPORT_API } from './hrefs';

/**
 * The filter lists (warehouses and categories that occur in the caller's own
 * eligible order lines), loaded ONCE per organization and person for the
 * session and kept only in memory: never persisted, and gone on a sign-out
 * or an organization switch (both reload the dashboard). A search, a sort or
 * another page never refetches them. They are never awaited with the
 * numbers: a slow or failed load leaves only the Warehouse and Category
 * selects waiting or disabled.
 *
 * Only a parsed answer for the SAME organization is kept; a failure (or an
 * aborted request) is not remembered, so the next mount or Retry asks again.
 */
const loaded = new Map<string, BookOrderOptionsResponse>();

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
  return answer;
}

/** Tests only. */
export function __resetBookReportOptionsForTests(): void {
  loaded.clear();
}
