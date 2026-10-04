'use client';

/**
 * The New order page's submission key (phone ordering PO-2, plan 3.4 and 3.6):
 * the pending record kept in this browser, and the hook that sends, resends,
 * withdraws and reads it through core's state machine.
 *
 * ═══ SETTLE, NEVER GUESS ═══
 *
 * The first press of Submit mints a key; the record `{ key, body, state,
 * sends, firstSentAt }` is written BEFORE the action is called, already
 * counting that send (if the write fails nothing is sent). The cart is locked
 * (CartProvider.setLocked) until the key has a FINAL outcome: placed, refused
 * (recorded, or refused on the only send) or withdrawn. "Check and finish"
 * sends the same key and body again; "Don't send it" withdraws under the
 * key's lock. A status read runs on its own after a reload and never unlocks
 * on `none`. Core decides every transition (orderSubmissionReducer); this
 * module only stores and calls.
 *
 * ═══ ONE ACCOUNT'S RECORD (judge X-1) ═══
 *
 * The record lives under `order-pending:v1:<userId>:<orgId>:<warehouseId>`
 * and is read only for the signed-in user (core parsePendingOrderSubmission
 * also checks the body's placer), so on a shared browser the next person
 * never sees, nor sends, another person's pending order. The body carries
 * the placer, and the database refuses it under any other account.
 */

import * as React from 'react';

import {
  ORDER_DEVICE_SAVE_FAILED_COPY,
  ORDER_SUBMISSION_OPEN,
  orderCallResultFromAction,
  orderSubmissionLocked,
  orderSubmissionReducer,
  parsePendingOrderSubmission,
  pendingOrderSubmissionOf,
  type CartState,
  type OrderCallResult,
  type OrderCreateRequestInput,
  type OrderSubmissionEvent,
  type OrderSubmissionState,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import {
  createOrderRequestAction,
  getOrderSubmissionAction,
  withdrawOrderSubmissionAction,
} from '@/server/actions/order-requests';

/** Where this browser keeps one account's pending send for one warehouse. */
export function orderPendingKey(
  userId: string,
  organizationId: string,
  warehouseId: string,
): string {
  return `order-pending:v1:${userId}:${organizationId}:${warehouseId}`;
}

/**
 * An action error code as the HTTP status the phone's route answers for the
 * same refusal (the service's serviceErrorStatus, plus rate_limited), so core
 * classifies a web refusal exactly as it classifies the phone's ApiError.
 * order-submission.test.ts pins it equal to serviceErrorStatus.
 */
export function actionStatusForCode(code: string): number {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'forbidden':
    case 'module_disabled':
      return 403;
    case 'not_found':
      return 404;
    case 'validation_error':
      return 400;
    case 'conflict':
    case 'plan_limit_exceeded':
      return 409;
    case 'rate_limited':
      return 429;
    default:
      return 500;
  }
}

/** Reads this account's pending record, or null. A record nothing ties to
 *  this account and key is removed, never shown. */
export function readPendingRecord(
  storage: Storage,
  key: string,
  userId: string,
): PendingOrderSubmission | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = parsePendingOrderSubmission(parsed, userId);
  if (record === null) {
    try {
      storage.removeItem(key);
    } catch {
      /* best effort */
    }
  }
  return record;
}

/** Writes the record, or removes it for null. Throws when the browser
 *  refuses (storage full or blocked): the caller then sends nothing. */
export function writePendingRecord(
  storage: Storage,
  key: string,
  record: PendingOrderSubmission | null,
): void {
  if (record === null) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(record));
}

/** The cart a pending body was built from: a locked cart always shows exactly
 *  what was sent (its kits' records are not in the body and start empty). */
export function cartStateFromPendingBody(
  body: OrderCreateRequestInput,
  warehouseId: string,
): CartState {
  const qty = new Map<string, number>();
  for (const l of body.lines) qty.set(l.itemId, (qty.get(l.itemId) ?? 0) + l.quantity);
  return {
    warehouseId,
    charterId: body.fulfillmentType === 'delivery' ? (body.deliveryCharterId ?? null) : null,
    fulfillmentType: body.fulfillmentType,
    onBehalfOf: body.onBehalfOf ?? null,
    notes: body.notes ?? '',
    neededBy: body.neededByLocal ?? '',
    lines: [...qty].map(([itemId, quantity]) => ({ itemId, quantity })),
    kits: {},
  };
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** An answer for another organization (the browser switched workspace while
 *  it was out) is no answer: the key stays live. */
function forThisOrganization(result: OrderCallResult, organizationId: string): OrderCallResult {
  if (!result.ok) return result;
  const body = result.body as { organizationId?: unknown } | null;
  if (!body || typeof body !== 'object' || body.organizationId !== organizationId) {
    return { ok: false, error: new Error('answer for another organization') };
  }
  return result;
}

export interface UseOrderSubmissionArgs {
  userId: string;
  organizationId: string;
  warehouseId: string;
  /** The cart's own hydration has run (its draft restored). */
  hydrated: boolean;
  setLocked: (locked: boolean) => void;
  /** A restored pending body, to show in the (locked) cart. */
  onRestore: (body: OrderCreateRequestInput) => void;
}

export interface OrderSubmissionControl {
  state: OrderSubmissionState;
  /** A send, a resend, a withdraw or the automatic status read is out. */
  busy: boolean;
  /** The record could not be written, so nothing was sent. */
  deviceError: string | null;
  /** The first press of Submit, with a freshly minted key in the body. */
  send: (body: OrderCreateRequestInput) => void;
  /** "Check and finish". */
  resend: () => void;
  /** "Don't send it". */
  withdraw: () => void;
  /** The success screen, the refusal or the withdrawn notice is done with. */
  dismiss: () => void;
}

export function useOrderSubmission({
  userId,
  organizationId,
  warehouseId,
  hydrated,
  setLocked,
  onRestore,
}: UseOrderSubmissionArgs): OrderSubmissionControl {
  const [state, setState] = React.useState<OrderSubmissionState>(ORDER_SUBMISSION_OPEN);
  const stateRef = React.useRef<OrderSubmissionState>(ORDER_SUBMISSION_OPEN);
  // The ref guard: set synchronously before any await, so a second tap in the
  // same tick finds it (React state is not a guard).
  const inFlight = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [deviceError, setDeviceError] = React.useState<string | null>(null);
  const key = orderPendingKey(userId, organizationId, warehouseId);
  // The latest onRestore, for the restore effect (kept current after each
  // render, never read while rendering).
  const onRestoreRef = React.useRef(onRestore);
  React.useLayoutEffect(() => {
    onRestoreRef.current = onRestore;
  });

  /** Persist what `next` needs on the device, then commit it. False when the
   *  write failed (nothing committed). */
  const commit = React.useCallback(
    (next: OrderSubmissionState): boolean => {
      const store = storage();
      try {
        if (!store) throw new Error('no storage');
        writePendingRecord(store, key, pendingOrderSubmissionOf(next));
      } catch {
        // A final outcome whose record cannot be removed still commits: the
        // stale record names a settled key, which the next status read
        // settles again. A live key whose record cannot be written does not.
        if (pendingOrderSubmissionOf(next) !== null) return false;
      }
      stateRef.current = next;
      setState(next);
      setLocked(orderSubmissionLocked(next));
      return true;
    },
    [key, setLocked],
  );

  const apply = React.useCallback(
    (event: OrderSubmissionEvent) => commit(orderSubmissionReducer(stateRef.current, event)),
    [commit],
  );

  const run = React.useCallback(
    async (
      call: () => Promise<OrderCallResult>,
      done: (result: OrderCallResult) => OrderSubmissionEvent,
    ) => {
      let result: OrderCallResult;
      try {
        result = forThisOrganization(await call(), organizationId);
      } catch (error) {
        result = { ok: false, error };
      }
      apply(done(result));
      inFlight.current = false;
      setBusy(false);
    },
    [apply, organizationId],
  );

  const callCreate = React.useCallback(
    async (body: OrderCreateRequestInput) =>
      orderCallResultFromAction(await createOrderRequestAction(body), actionStatusForCode),
    [],
  );

  const send = React.useCallback(
    (body: OrderCreateRequestInput) => {
      if (inFlight.current) return;
      inFlight.current = true;
      let current = stateRef.current;
      if (
        current.phase === 'refused' ||
        current.phase === 'withdrawn' ||
        current.phase === 'placed'
      ) {
        current = orderSubmissionReducer(current, { type: 'dismiss' });
      }
      const next = orderSubmissionReducer(current, {
        type: 'send',
        key: body.idempotencyKey,
        body,
        at: new Date().toISOString(),
      });
      if (next === current || !commit(next)) {
        if (next !== current) setDeviceError(ORDER_DEVICE_SAVE_FAILED_COPY);
        inFlight.current = false;
        return;
      }
      setDeviceError(null);
      setBusy(true);
      void run(
        () => callCreate(body),
        (result) => ({ type: 'send-result', result }),
      );
    },
    [callCreate, commit, run],
  );

  const resend = React.useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = stateRef.current;
    const next = orderSubmissionReducer(current, { type: 'resend' });
    if (next === current || next.phase !== 'sending' || !commit(next)) {
      if (next !== current) setDeviceError(ORDER_DEVICE_SAVE_FAILED_COPY);
      inFlight.current = false;
      return;
    }
    setDeviceError(null);
    setBusy(true);
    const body = next.pending.body as OrderCreateRequestInput;
    void run(
      () => callCreate(body),
      (result) => ({ type: 'send-result', result }),
    );
  }, [callCreate, commit, run]);

  const withdraw = React.useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = stateRef.current;
    const next = orderSubmissionReducer(current, { type: 'withdraw' });
    if (next === current || next.phase !== 'withdrawing' || !commit(next)) {
      inFlight.current = false;
      return;
    }
    setBusy(true);
    const pendingKey = next.pending.key;
    void run(
      async () =>
        orderCallResultFromAction(
          await withdrawOrderSubmissionAction({ warehouseId, key: pendingKey }),
          actionStatusForCode,
        ),
      (result) => ({ type: 'withdraw-result', result }),
    );
  }, [commit, run, warehouseId]);

  const dismiss = React.useCallback(() => {
    apply({ type: 'dismiss' });
  }, [apply]);

  // A pending record found on load: lock at once, show the sent body, and
  // read the key's status (which only settles it when it reports a final
  // outcome). Once per mount, after the cart's own draft is restored.
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (!hydrated || restored.current) return;
    restored.current = true;
    const store = storage();
    const record = store ? readPendingRecord(store, key, userId) : null;
    if (!record) return;
    const next = orderSubmissionReducer(stateRef.current, { type: 'restore', pending: record });
    if (next === stateRef.current || !commit(next)) return;
    if (!record.bodyUnreadable) onRestoreRef.current(record.body);
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void run(
      async () =>
        orderCallResultFromAction(
          await getOrderSubmissionAction({ warehouseId, key: record.key }),
          actionStatusForCode,
        ),
      (result) => ({ type: 'status-result', result }),
    );
  }, [hydrated, key, userId, warehouseId, commit, run]);

  return { state, busy, deviceError, send, resend, withdraw, dismiss };
}
