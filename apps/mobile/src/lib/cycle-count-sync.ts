import * as Network from 'expo-network';
import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getAccountDisabled } from './account-disabled-state';
import { api } from './api';
import {
  outboxAck,
  outboxBumpFailure,
  outboxMarkSending,
  outboxPending,
  outboxReject,
  totalPendingCount,
} from './cycle-count-cache';
import { classifyDrainFailure } from './drain-failure';
import { countRejected } from './queue';

/**
 * Cycle-count sync engine.
 *
 * State machine:
 *   idle      → nothing pending, last drain succeeded
 *   syncing   → drainOutbox() in flight
 *   offline   → expo-network reports no connection
 *   failing   → last drain attempt errored on at least one row
 *
 * Triggers:
 *   - app foreground (AppState 'active')
 *   - network state change → 'connected'
 *   - explicit forceSync() (pull-to-refresh, badge tap)
 *   - 60s heartbeat while foregrounded
 *
 * Drain strategy: sequential loop (NOT parallel). Each row gets its
 * own AbortController and its own server roundtrip; failures bump
 * `attempts` so the exponential-backoff filter in `outboxPending()`
 * holds them off. A row that takes 5 attempts to fail won't retry
 * for ~32s; capped at 5 minutes. This keeps a flapping endpoint from
 * piling up identical retries on every trigger.
 */

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'failing';

export interface SyncSnapshot {
  status: SyncStatus;
  pendingCount: number;
  /**
   * Terminally REJECTED rows still on the device — work that was queued, will
   * never be sent, and has to stop being invisible. The badge said "All synced"
   * over the top of it, because `pendingCount` (correctly) excludes a row no
   * drain will ever read again. Counted separately so the badge can tell the
   * truth without the drains ever seeing these rows.
   */
  rejectedCount: number;
  lastError: string | null;
  lastSyncAt: number | null;
}

type Listener = (snap: SyncSnapshot) => void;

class CycleCountSyncEngine {
  private status: SyncStatus = 'idle';
  private pendingCount = 0;
  private rejectedCount = 0;
  private lastError: string | null = null;
  private lastSyncAt: number | null = null;
  private listeners = new Set<Listener>();
  private inFlight = false;
  private mounted = false;

  private appStateSub: { remove(): void } | null = null;
  private networkSub: { remove(): void } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Wire up triggers. Idempotent — calling twice is a no-op. */
  start() {
    if (this.mounted) return;
    this.mounted = true;

    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    // expo-network 7's listener: subscribe to network state changes.
    try {
      const sub = Network.addNetworkStateListener?.(this.onNetwork);
      if (sub && typeof (sub as { remove?: () => void }).remove === 'function') {
        this.networkSub = sub as { remove(): void };
      }
    } catch {
      // older expo-network versions don't expose a listener; we still
      // sync on app foreground + heartbeat, so this is graceful.
    }
    this.heartbeat = setInterval(() => {
      void this.refreshNetworkAndDrain();
    }, 60_000);

    // Kick off an initial drain once mounted.
    void this.refreshNetworkAndDrain();
  }

  stop() {
    if (!this.mounted) return;
    this.mounted = false;
    this.appStateSub?.remove();
    this.networkSub?.remove();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.appStateSub = null;
    this.networkSub = null;
    this.heartbeat = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): SyncSnapshot {
    return {
      status: this.status,
      pendingCount: this.pendingCount,
      rejectedCount: this.rejectedCount,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
    };
  }

  /**
   * Refresh `pendingCount` (e.g. after a UI-side updateLocalLine) so
   * the badge updates immediately instead of waiting for the next
   * drain. Cheap enough — single COUNT(*) query.
   */
  async refreshPendingCount(): Promise<void> {
    this.pendingCount = await totalPendingCount();
    this.rejectedCount = await this.safeRejectedCount();
    this.emit();
  }

  /**
   * The rejected tally must never be able to break a drain: it is display-only,
   * and a failed count is answered with the last known value rather than an
   * exception thrown out of the sync lifecycle.
   */
  private async safeRejectedCount(): Promise<number> {
    try {
      return await countRejected();
    } catch (e) {
      console.warn('[cycle-count-sync] rejected count failed', e);
      return this.rejectedCount;
    }
  }

  /** Force a drain attempt now (badge tap, pull-to-refresh). */
  async forceSync(): Promise<void> {
    await this.refreshNetworkAndDrain();
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === 'active') {
      void this.refreshNetworkAndDrain();
    }
  };

  private onNetwork = (state: Network.NetworkStateEvent) => {
    const online = Boolean(state.isConnected && state.isInternetReachable !== false);
    if (online && this.status === 'offline') {
      void this.refreshNetworkAndDrain();
    } else if (!online) {
      this.status = 'offline';
      this.emit();
    }
  };

  private async refreshNetworkAndDrain(): Promise<void> {
    if (this.inFlight) return;
    const online = await this.isOnline();
    this.pendingCount = await totalPendingCount();
    this.rejectedCount = await this.safeRejectedCount();
    if (!online) {
      this.status = 'offline';
      this.emit();
      return;
    }
    if (this.pendingCount === 0) {
      this.status = 'idle';
      this.lastError = null;
      this.emit();
      return;
    }
    await this.drainOutbox();
  }

  private async isOnline(): Promise<boolean> {
    try {
      const state = await Network.getNetworkStateAsync();
      return Boolean(state.isConnected && state.isInternetReachable !== false);
    } catch {
      return true;
    }
  }

  private async drainOutbox(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.status = 'syncing';
    this.lastError = null;
    this.emit();

    let anyFailed = false;
    let anyRejected = false;
    try {
      const due = await outboxPending();
      // Filter to record_count rows only — this engine owns the
      // cycle-count flow. Other kinds (receive_po_line, etc.) are
      // drained by the legacy `sync.ts` worker.
      const cycleRows = due.filter((r) => r.kind === 'record_count');

      for (const row of cycleRows) {
        const cancelled = !(await this.isOnline());
        if (cancelled) {
          this.status = 'offline';
          this.emit();
          break;
        }
        try {
          await outboxMarkSending(row.id);
          const controller = new AbortController();
          await this.sendRecordCount(row.payload, controller.signal);
          await outboxAck(row.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.lastError = msg;
          // A 401 on a known-disabled account is TERMINAL. Bumping the failure
          // counter here would keep the row in the backoff rotation forever and
          // — the real damage — replay the count edit the instant the account
          // is re-enabled. outboxReject parks it and clears the line's dirty
          // flag in one transaction so the screen does not strand a line as
          // permanently unsynced with no row left to sync it.
          const outcome = classifyDrainFailure(e, {
            accountDisabled: getAccountDisabled(),
          });
          if (outcome === 'rejected') {
            anyRejected = true;
            await outboxReject(row.id, msg);
          } else {
            anyFailed = true;
            await outboxBumpFailure(row.id, msg);
          }
        }
      }

      this.pendingCount = await totalPendingCount();
      this.rejectedCount = await this.safeRejectedCount();
      if (this.status !== 'offline') {
        // 'failing' means "still retrying". A rejected row will never be
        // retried, so the engine is genuinely idle afterwards.
        this.status = anyFailed ? 'failing' : 'idle';
      }
      if (!anyFailed && !anyRejected) {
        // Only a clean pass may clear the error and stamp a success — a drain
        // that rejected everything synced nothing.
        this.lastError = null;
        this.lastSyncAt = Date.now();
      }
      this.emit();
    } finally {
      this.inFlight = false;
    }
  }

  private async sendRecordCount(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const lineId = typeof payload.lineId === 'string' ? payload.lineId : '';
    const cycleCountId =
      typeof payload.cycleCountId === 'string' ? payload.cycleCountId : '';
    const counted =
      typeof payload.countedQuantity === 'number'
        ? payload.countedQuantity
        : Number(payload.countedQuantity);
    if (!lineId || !cycleCountId) {
      throw new Error('record_count: missing ids');
    }
    if (!Number.isFinite(counted) || counted < 0) {
      throw new Error('record_count: invalid counted quantity');
    }

    // Route through the gated API endpoint instead of a raw
    // cycle_count_lines update. The server then enforces stock:adjust
    // permission, the per-warehouse write gate (assertSessionAccess), the
    // in-progress + counted_by RLS, and the 1e9 quantity cap — none of
    // which a direct PostgREST write honors. It also surfaces real
    // rejections: the old raw update had no .select(), so an RLS-blocked
    // write returned 0 rows silently and the row was ACKed as if it
    // succeeded. The endpoint uses .select().maybeSingle(), so a blocked
    // or no-longer-editable line now throws and the outbox retries.
    // (Mirrors the legacy sync.ts record_count drain.)
    await api(`/api/v1/cycle-counts/${cycleCountId}/lines/${lineId}/record`, {
      method: 'POST',
      body: { ...payload, countedQuantity: counted },
      signal,
    });
  }

  private emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (e) {
        console.warn('[cycle-count-sync] listener error', e);
      }
    }
  }
}

export const cycleCountSync = new CycleCountSyncEngine();

/** Hook: subscribes the calling component to sync-engine events. */
export function useSyncStatus(): SyncSnapshot {
  const [snap, setSnap] = React.useState<SyncSnapshot>(() => cycleCountSync.snapshot());
  React.useEffect(() => {
    const off = cycleCountSync.subscribe(setSnap);
    return off;
  }, []);
  return snap;
}
