/**
 * The phone's member-role cache, behind useRole().
 *
 * ═══ WHY IT IS NOT A PLAIN "READ ONCE PER PROCESS" CACHE ANY MORE ═══
 *
 * useRole() used to read `organization_members.role` once and keep it for the
 * life of the app process, keyed by user and org. Nothing cleared it: signing
 * out and back in served the same answer, and a role changed by an admin was
 * not seen until the app was killed.
 *
 * That became a correctness problem with 0371. The stock-in-other-warehouses
 * reads (holdings-elsewhere.ts) SKIP their request for managers and above,
 * who see every holding. A manager demoted to staff kept the cached 'manager'
 * on their phone, so the item screen, the scan sheet and the Move and Remove
 * sheets showed only their own warehouses' holdings with no "in other
 * warehouses" line and no "could not load" note: a partial view presented as
 * complete. (Display only: the server decides every write.)
 *
 * So the cached role is served immediately (no loading flash on every screen)
 * but it is RE-READ in the background once it is older than
 * ROLE_REVALIDATE_MS, and every mounted useRole() hears about a change, so a
 * screen whose reads depend on the role re-runs them. Signing out clears it.
 * A failed re-read keeps the role already known rather than flickering the
 * app's role gates to "no role".
 *
 * Pure: no React, no Supabase client (the hook passes the read in), so it
 * runs under the node test environment.
 */
import type { Role } from '@stockpilot/core';

/** How old a cached role may be before a screen that asks re-reads it. */
export const ROLE_REVALIDATE_MS = 30_000;

interface Entry {
  userId: string;
  orgId: string;
  role: Role;
  readAt: number;
}

let entry: Entry | null = null;
let inFlight: { key: string; token: symbol; promise: Promise<RoleReadResult> } | null = null;
const listeners = new Set<() => void>();

/** What one role read found. `ok: false` is a failed read, not "no role". */
export type RoleReadResult = { ok: true; role: Role | null } | { ok: false };

const keyOf = (userId: string, orgId: string) => `${userId}:${orgId}`;

/** The cached role for this user in this org, or null. */
export function cachedRoleFor(userId: string, orgId: string): Role | null {
  return entry && entry.userId === userId && entry.orgId === orgId ? entry.role : null;
}

/** True when there is no role for this identity, or it is due a re-read. */
export function roleNeedsRead(userId: string, orgId: string, now: number = Date.now()): boolean {
  if (!entry || entry.userId !== userId || entry.orgId !== orgId) return true;
  return now - entry.readAt >= ROLE_REVALIDATE_MS;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Record a read's answer. Listeners hear about it only when the role changed. */
export function storeRole(
  userId: string,
  orgId: string,
  role: Role | null,
  now: number = Date.now(),
): void {
  const before = cachedRoleFor(userId, orgId);
  entry = role ? { userId, orgId, role, readAt: now } : null;
  if (before !== role) notify();
}

/** Forget the role (sign-out). */
export function clearRoleCache(): void {
  const had = entry !== null;
  entry = null;
  inFlight = null;
  if (had) notify();
}

/** Called whenever the cached role changes. Returns the unsubscribe. */
export function subscribeRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the role for this identity, at most one request at a time: screens
 * that mount together share the one in flight. A successful answer is stored
 * (and announced if it changed); a failed one leaves the cache as it was.
 */
export function readRoleOnce(
  userId: string,
  orgId: string,
  read: () => Promise<RoleReadResult>,
): Promise<RoleReadResult> {
  const key = keyOf(userId, orgId);
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const token = Symbol('role-read');
  const run = async (): Promise<RoleReadResult> => {
    let res: RoleReadResult;
    try {
      res = await read();
    } catch {
      res = { ok: false };
    }
    // A sign-out (or another identity's read) while this was in flight: the
    // answer belongs to nobody now, so it is not stored.
    if (inFlight?.token === token) {
      inFlight = null;
      if (res.ok) storeRole(userId, orgId, res.role);
    }
    return res;
  };
  // run() yields at its first await, so this is set before it can finish.
  const promise = run();
  inFlight = { key, token, promise };
  return promise;
}

/** Tests only: forget everything, listeners included. */
export function resetRoleCacheForTests(): void {
  entry = null;
  inFlight = null;
  listeners.clear();
}
