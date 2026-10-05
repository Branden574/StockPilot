import {
  ORDER_ADD_WHILE_LOCKED_COPY,
  ORDER_DEVICE_SAVE_FAILED_COPY,
  ORDER_SUBMISSION_OPEN,
  orderCallResultForOrganization,
  orderSubmissionCanResend,
  orderSubmissionLocked,
  orderSubmissionReducer,
  refuseAddWhileLocked,
  type OrderCallResult,
  type OrderCreateRequestInput,
  type OrderSubmissionEvent,
  type OrderSubmissionState,
  type PendingOrderSubmission,
} from '@stockpilot/core';

/**
 * PLACING ONE ORDER REQUEST FROM THE PHONE, ONCE (phone ordering PO-4, plan
 * 3.4): core's submission state machine (orderSubmissionReducer) wired to the
 * three calls and to the device's draft record.
 *
 * SETTLE, NEVER GUESS. A send whose answer did not arrive may or may not have
 * placed the order, so the cart stays locked, with the same key and the same
 * body, until the key has a FINAL outcome: placed, refused (recorded under the
 * key, or refused on the only send) or withdrawn. Core decides every
 * transition; this module only orders the steps:
 *
 *   1. A REF GUARD (`inFlight`), set synchronously before any await, stops a
 *      second tap in the same frame (React state is not a guard, audit D7).
 *   2. WRITE-AHEAD: the next state's draft record (the pending send, already
 *      counting the send about to leave) is written and awaited BEFORE the
 *      request is handed to api(). If that write fails, nothing is sent and
 *      the person reads core's "Couldn't save your order request on this
 *      device, so it wasn't sent."
 *   3. The call, under the organization the cart was built in and only as the
 *      account that built it (api.ts orgId, asUserId).
 *   4. The answer, read through core orderCallResultForOrganization (an answer
 *      for another organization never settles this key) and the reducer; the
 *      state it leads to is written, then shown. A final outcome whose record
 *      cannot be removed still shows: the record left names a settled key,
 *      which the next status read settles again.
 *
 * ONE TAP IS ONE INVOCATION. A send ("Submit order request", "Check and
 * finish") and a withdraw ("Don't send it") happen only on a tap. Status reads
 * run on their own (opening the storefront, the app returning to the
 * foreground, the connection coming back) and only ever settle a key that has
 * a final outcome: `none` never unlocks.
 *
 * Framework-free (no React, no native module): the app wires it to api() and
 * AsyncStorage (session.ts); vitest drives it with fakes.
 */

export interface SubmitEngineDeps {
  organizationId: string;
  /** Write the draft record `next` needs (its pending send, or none) and wait
   *  for it. Rejects when the device refuses the write. */
  persist(next: OrderSubmissionState): Promise<void>;
  place(body: OrderCreateRequestInput, onSend: () => void): Promise<OrderCallResult>;
  status(key: string): Promise<OrderCallResult>;
  withdraw(key: string): Promise<OrderCallResult>;
  /** The clock, for the record's firstSentAt. */
  now(): Date;
}

export interface SubmitEngineSnapshot {
  state: OrderSubmissionState;
  /** A send, a resend, a withdraw or a status read is out. */
  busy: boolean;
  /** The record could not be written, so nothing was sent. */
  deviceError: string | null;
  /** The request has been handed to fetch (onSend) for the send now out. */
  sent: boolean;
}

export interface SubmitEngine {
  getSnapshot(): SubmitEngineSnapshot;
  subscribe(listener: () => void): () => void;
  /** A pending send found on the device: lock and read its status. Never
   *  sends it. False when the state already holds a key. */
  restore(pending: PendingOrderSubmission): boolean;
  /** The first press of Submit (the body carries its freshly minted key). */
  submit(body: OrderCreateRequestInput): Promise<void>;
  /** "Check and finish": the same key and body again. */
  checkAndFinish(): Promise<void>;
  /** "Don't send it": withdraw under the key's lock. */
  dontSend(): Promise<void>;
  /** The automatic status read (only while unconfirmed). */
  readStatus(): Promise<void>;
  /** The success screen, the refusal, the withdrawn notice or the device
   *  error is done with. */
  dismiss(): void;
  /** The sentence that refuses an add or an edit while the key is live, or
   *  null when the cart is free (core refuseAddWhileLocked). Also from the
   *  moment Submit is pressed: while its record is still being written the
   *  state is open, but the send is on its way (PO-4 review). */
  refuseChange(): string | null;
  /** Stop telling listeners (the account or organization ended). Calls
   *  already out still write their answer (the epoch check in persist decides
   *  whether it lands). */
  dispose(): void;
}

export function createSubmitEngine(deps: SubmitEngineDeps): SubmitEngine {
  let state: OrderSubmissionState = ORDER_SUBMISSION_OPEN;
  let busy = false;
  let deviceError: string | null = null;
  let sent = false;
  let inFlight = false;
  let disposed = false;
  let snapshot: SubmitEngineSnapshot = { state, busy, deviceError, sent };
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = { state, busy, deviceError, sent };
    if (disposed) return;
    for (const l of listeners) l();
  };

  /** Write what `next` needs, then show it. False (nothing shown) when the
   *  write failed and `next` holds a live key: a live key is never shown as
   *  sent unless its record is on the device. */
  const commit = async (next: OrderSubmissionState, strict: boolean): Promise<boolean> => {
    try {
      await deps.persist(next);
    } catch {
      if (strict) return false;
    }
    state = next;
    return true;
  };

  const settleWith = async (event: OrderSubmissionEvent) => {
    const next = orderSubmissionReducer(state, event);
    if (next === state) return;
    await commit(next, false);
    // A key settled: a resend that could not be saved is no longer the news.
    if (!orderSubmissionLocked(state)) deviceError = null;
  };

  const call = async (run: () => Promise<OrderCallResult>): Promise<OrderCallResult> => {
    let result: OrderCallResult;
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, error };
    }
    return orderCallResultForOrganization(result, deps.organizationId);
  };

  const send = async (next: OrderSubmissionState) => {
    // The record for the send about to leave, then the send.
    if (next.phase !== 'sending' || !(await commit(next, true))) {
      deviceError = ORDER_DEVICE_SAVE_FAILED_COPY;
      busy = false;
      inFlight = false;
      publish();
      return;
    }
    deviceError = null;
    sent = false;
    publish();
    const body = next.pending.body as OrderCreateRequestInput;
    const result = await call(() =>
      deps.place(body, () => {
        sent = true;
        publish();
      }),
    );
    await settleWith({ type: 'send-result', result });
    busy = false;
    inFlight = false;
    publish();
  };

  const engine: SubmitEngine = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    restore(pending) {
      const next = orderSubmissionReducer(state, { type: 'restore', pending });
      if (next === state) return false;
      // Already on the device: nothing to write.
      state = next;
      publish();
      void engine.readStatus();
      return true;
    },

    async submit(body) {
      if (inFlight) return;
      inFlight = true;
      busy = true;
      if (state.phase === 'placed' || state.phase === 'refused' || state.phase === 'withdrawn') {
        state = orderSubmissionReducer(state, { type: 'dismiss' });
      }
      const next = orderSubmissionReducer(state, {
        type: 'send',
        key: body.idempotencyKey,
        body,
        at: deps.now().toISOString(),
      });
      if (next === state) {
        busy = false;
        inFlight = false;
        publish();
        return;
      }
      await send(next);
    },

    async checkAndFinish() {
      if (inFlight) return;
      if (!orderSubmissionCanResend(state)) return;
      inFlight = true;
      busy = true;
      await send(orderSubmissionReducer(state, { type: 'resend' }));
    },

    async dontSend() {
      if (inFlight) return;
      const next = orderSubmissionReducer(state, { type: 'withdraw' });
      if (next === state || next.phase !== 'withdrawing') return;
      inFlight = true;
      busy = true;
      await commit(next, false);
      publish();
      const result = await call(() => deps.withdraw(next.pending.key));
      await settleWith({ type: 'withdraw-result', result });
      busy = false;
      inFlight = false;
      publish();
    },

    async readStatus() {
      if (inFlight || state.phase !== 'unconfirmed') return;
      inFlight = true;
      busy = true;
      publish();
      const key = state.pending.key;
      const result = await call(() => deps.status(key));
      await settleWith({ type: 'status-result', result });
      busy = false;
      inFlight = false;
      publish();
    },

    dismiss() {
      deviceError = null;
      const next = orderSubmissionReducer(state, { type: 'dismiss' });
      state = next;
      publish();
    },

    refuseChange() {
      if (orderSubmissionLocked(state)) return refuseAddWhileLocked(livePending(state));
      // The write-ahead before a send (the ref guard is set, the state is
      // still open): a change now would lock a cart that differs from the
      // body about to be sent (PO-4 review, probe P1).
      return inFlight ? ORDER_ADD_WHILE_LOCKED_COPY : null;
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
  return engine;
}

/** Whether the unconfirmed panel shows: a send whose answer did not arrive,
 *  or a resend or "Don't send it" now out. The FIRST send keeps the Submit
 *  button, waiting, as on the web (PO-2 review); the panel comes once that
 *  send is unanswered. */
export function showUnconfirmedPanel(state: OrderSubmissionState): boolean {
  if (state.phase === 'unconfirmed' || state.phase === 'withdrawing') return true;
  return state.phase === 'sending' && state.pending.sends > 1;
}

function livePending(state: OrderSubmissionState): PendingOrderSubmission | null {
  return state.phase === 'sending' || state.phase === 'withdrawing' || state.phase === 'unconfirmed'
    ? state.pending
    : null;
}
