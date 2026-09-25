/**
 * What the header sync badge says (components/SyncStatusBadge.tsx), decided
 * here so vitest can execute it: the component imports react-native.
 *
 *   syncing                          spinner + "Syncing…"             (primary)
 *   offline                          "Offline · N queued" / "Offline" (muted)
 *   failing                          "Sync issue · retrying"          (destructive)
 *   idle, nothing queued, rejected:
 *     never sent only                "N not sent"                     (destructive)
 *     not confirmed only             "N not confirmed"                (warning)
 *     both                           "N need checking"                (destructive)
 *   idle, nothing queued             "All synced"                     (success)
 *   idle, pendingCount > 0           "N pending"                      (warning)
 *
 * A terminal REJECTION leaves `pendingCount` at zero (no drain reads the row
 * again), so the badge must say so rather than "All synced" over work that
 * never landed; Settings > Unsent work lists what it was.
 *
 * NOT CONFIRMED is a different fact: a stock adjustment sent from the outbox
 * whose answer never came back (adjust-outbox.ts). It left the phone and MAY
 * have been applied. Calling it "not sent" tells the operator to enter it
 * again, which double counts it if the first one committed. So it is counted
 * apart (`unconfirmedCount`, part of `rejectedCount`) and worded as
 * Settings > Unsent work words it (rejected-work.ts unsentWorkDetail).
 */

export type SyncBadgeTone = 'primary' | 'muted' | 'destructive' | 'success' | 'warning';

export interface SyncBadgeInput {
  status: 'idle' | 'syncing' | 'offline' | 'failing';
  pendingCount: number;
  /** Every rejected row of the live account, unconfirmed adjustments included. */
  rejectedCount: number;
  /** Of `rejectedCount`: stock adjustments that may have been applied. */
  unconfirmedCount: number;
}

export interface SyncBadgeState {
  label: string;
  tone: SyncBadgeTone;
  spinner: boolean;
}

export function syncBadgeState(s: SyncBadgeInput): SyncBadgeState {
  if (s.status === 'syncing') return { label: 'Syncing…', tone: 'primary', spinner: true };
  if (s.status === 'offline') {
    return {
      label: s.pendingCount > 0 ? `Offline · ${s.pendingCount} queued` : 'Offline',
      tone: 'muted',
      spinner: false,
    };
  }
  if (s.status === 'failing') {
    return { label: 'Sync issue · retrying', tone: 'destructive', spinner: false };
  }
  if (s.pendingCount === 0 && s.rejectedCount > 0) {
    // Counts read a moment apart can disagree; clamp, never negative.
    const unconfirmed = Math.min(Math.max(s.unconfirmedCount, 0), s.rejectedCount);
    const neverSent = s.rejectedCount - unconfirmed;
    if (unconfirmed === 0) {
      return { label: `${neverSent} not sent`, tone: 'destructive', spinner: false };
    }
    if (neverSent === 0) {
      return { label: `${unconfirmed} not confirmed`, tone: 'warning', spinner: false };
    }
    return { label: `${s.rejectedCount} need checking`, tone: 'destructive', spinner: false };
  }
  if (s.pendingCount === 0) return { label: 'All synced', tone: 'success', spinner: false };
  return { label: `${s.pendingCount} pending`, tone: 'warning', spinner: false };
}
