import {
  isUuid,
  orderLineItemName,
  type FulfillmentType,
  type OrderStatus,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { derivePickSlipStale } from '../../components/add-order-items';
import { createSequenceGuard, type SequenceGuard } from '../debounced-list-load';
import {
  deliveryRoutingFromOrgRow,
  isMissingEmailRoutingColumn,
  needsDeliveryRequestData,
  parseCharterAddress,
} from '../delivery-request-actions';
import { readErrorMessage } from '../id-batches';
import { createNewestLoads } from '../newest-load';
import { needsNeededByZoneRead } from '../order-needed-by';
import {
  orderReadinessAudience,
  readinessPermissionsFor,
  reconcileReadiness,
  shouldReadReadiness,
} from '../order-readiness';
import {
  exchangeItemIdsOf,
  exchangeLinesByReturn,
  ORDER_RETURNS_EXCHANGE_SELECT,
  ORDER_RETURNS_SELECT,
  parseOrderReturns,
  shouldLoadOrderReturns,
} from '../order-returns';
import {
  needsOrderWarehouseScope,
  readOrderWarehouseScope,
  type OrderWarehouseScope,
} from '../order-warehouse-scope';
import { profileFromEmbed, resolveRequesterLabel } from '../requester-label';
import {
  focusEffectCallback,
  layoutEffectCallback,
  screenCallback,
  stateInitializer,
} from './screen-functions';

/**
 * The phone's order screen (app/order/[id].tsx) with its loads RUN: the
 * screen's own `load`, `loadAttachments`, `reload`, focus effect and state
 * initializers, compiled from its source (screen-functions), bound to a fake
 * transport, and called the way React calls them. Not a test file: vitest
 * only collects `*.test.ts`, and the tests that need it import it.
 *
 * React itself is the one thing played by hand, as each render would:
 * render() builds that render's `load` from the values it reads (the role,
 * the permissions the screen gates with, whether the saved set has been
 * read, the connection), runs the screen's layout effect for it (which keeps
 * it in the runner for `reload`) and returns the screen's focus effect for
 * it, which the test runs when the screen would (on focus, and when `load`
 * changed while in focus). The screen's state lives in `state`, set only
 * through the setters `load` and `loadAttachments` call.
 *
 * Whatever the screen's source holds is what runs: a screen without the
 * review fixes runs as it did then (its focus effect calls `load` directly,
 * its handlers call the `load` their render built), so a test fails on what
 * the screen does, not on a missing name. A test that runs the importing
 * test file with `vi.mock('expo-linking', ...)`: delivery-request-actions
 * imports it.
 */

export const SCREEN = 'app/order/[id].tsx';
export const ORG = '0c000000-0000-0000-0000-0000000000c1';
export const ORDER_ID = '0e000000-0000-0000-0000-0000000000e1';
const LINE_ID = '0f000000-0000-0000-0000-0000000000f1';
const ITEM_ID = '0b000000-0000-0000-0000-0000000000b9';

/** The order as the server holds it: what the gates read off the header. */
export interface OrderRow {
  status: OrderStatus;
  warehouseId: string;
  fulfillmentType: FulfillmentType;
  requesterUserId: string | null;
  assignedPickerId: string | null;
  assignedDeliveryUserId: string | null;
  inTransitAt: string | null;
}

/** One answer of the fake transport, shaped as supabase-js answers. */
export interface Answer {
  data: unknown;
  error: unknown;
  status?: number;
}

/** The fake Supabase client one render's `load` reads through. */
export interface FakeOrderClient {
  /** Every table read, in order. */
  reads: string[];
  from(table: string): unknown;
}

/**
 * A client whose tables answer through `answers` (called when the read is
 * awaited, so a test can hand back a promise it holds open). A table with no
 * answer gives no rows and no error.
 */
export function fakeOrderClient(
  answers: Partial<Record<string, () => Answer | Promise<Answer>>>,
): FakeOrderClient {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      let answer: Promise<Answer> | null = null;
      const once = (): Promise<Answer> =>
        (answer ??= Promise.resolve().then(() => (answers[table] ?? noRows)()));
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => once(),
        then: (ok: (a: Answer) => unknown, fail?: (e: unknown) => unknown) => once().then(ok, fail),
      };
      return chain;
    },
  };
}

const noRows = (): Answer => ({ data: null, error: null, status: 200 });

/** The header read's answer for `row` (the screen's select, with no embeds that matter). */
export function headerAnswer(row: OrderRow): Answer {
  return {
    data: {
      id: ORDER_ID,
      order_number: 101,
      status: row.status,
      requester_name: 'A requester',
      requester_email: 'requester@example.test',
      requester_user_id: row.requesterUserId,
      requester_org_label: null,
      requester_deleted_at: null,
      signed_by_name: null,
      signed_at: null,
      created_at: '2026-11-02T18:00:00Z',
      warehouse_id: row.warehouseId,
      pick_slip_generated_at: null,
      assigned_delivery_user_id: row.assignedDeliveryUserId,
      assigned_picker_id: row.assignedPickerId,
      fulfillment_type: row.fulfillmentType,
      signature_token: null,
      in_transit_at: row.inTransitAt,
      needed_by: null,
      notes: null,
      delivery_charter_id: null,
      replacement_for_return_id: null,
      warehouse: { name: 'A warehouse' },
      requester: null,
      picker: null,
    },
    error: null,
    status: 200,
  };
}

/** The lines read's answer: one line of two units, none picked. */
export function linesAnswer(): Answer {
  return {
    data: [
      {
        id: LINE_ID,
        item_id: ITEM_ID,
        created_at: '2026-11-02T18:00:00Z',
        quantity_requested: 2,
        quantity_fulfilled: 0,
        quantity_picked: 0,
        returned_quantity: 0,
        item: { name: 'An item', sku: 'SKU-1', charter_id: null, charter: null },
      },
    ],
    error: null,
    status: 200,
  };
}

/** user_warehouse_assignments as the viewer reads it: the warehouses they work in. */
export function workIn(...warehouseIds: string[]): Answer {
  return { data: warehouseIds.map((warehouse_id) => ({ warehouse_id })), error: null };
}

/** The answers of an order read at once: the header, its line, the warehouses, the org row. */
export function orderAnswers(
  row: OrderRow,
  workingIn: readonly string[],
): Partial<Record<string, () => Answer | Promise<Answer>>> {
  return {
    order_requests: () => headerAnswer(row),
    order_request_lines: () => linesAnswer(),
    user_warehouse_assignments: () => workIn(...workingIn),
    organizations: () => ({
      data: { timezone: 'America/Los_Angeles', email_routing: null },
      error: null,
    }),
  };
}

/** What `load` puts on screen: the header's facts the gates read, and the warehouses it read. */
export interface ShownOrder extends OrderRow {
  warehouseScope: OrderWarehouseScope | null;
  [field: string]: unknown;
}

export interface AttachmentsRead {
  attachments: unknown[];
  error: string | null;
}

/** What the screen holds: what its loads set, and every view kept for offline. */
export interface ScreenState {
  order: ShownOrder | null | undefined;
  loadError: string | null | undefined;
  loading: boolean;
  attachments: unknown[] | undefined;
  attachmentsError: string | null | undefined;
  shipment: unknown;
  remembered: { order: ShownOrder; attachments: unknown[] }[];
}

/** What one render of the screen reads `load` with. */
export interface Render {
  role: Role | null;
  /** What the screen gates with: permissionsOnceRead of the saved set. */
  permissions: ReadonlySet<Permission> | undefined;
  permissionsRead: boolean;
  offline?: boolean;
  client: FakeOrderClient;
  /** The attachments read (the screen's readAttachments); none, at once, by default. */
  readAttachments?: () => Promise<AttachmentsRead | null>;
  /** The tracking read (getOrderShipment); no shipment, at once, by default. */
  getOrderShipment?: () => Promise<unknown>;
}

export interface Rendered {
  /** This render's `load`, as the screen built it. */
  load: () => Promise<void>;
  /** This render's loadAttachments (the upload, delete and Try again paths). */
  loadAttachments: () => Promise<void>;
  /** The screen's focus effect for this render: what React runs when `load` changed in focus. */
  focus: () => void;
  /** The permissions `load` read with (readinessPermissionsFor, as the screen derives them). */
  rpApprove: boolean;
  rpItems: boolean;
}

/** Calls `make`, or answers undefined when the screen does not have it (a screen before the review fixes). */
function ifPresent<T>(make: () => T): T | undefined {
  try {
    return make();
  } catch (e) {
    if (e instanceof Error && /not found/.test(e.message)) return undefined;
    throw e;
  }
}

/** The order screen for the signed-in member `userId`. */
export function orderScreen(userId: string) {
  const state: ScreenState = {
    order: undefined,
    loadError: undefined,
    loading: true,
    attachments: undefined,
    attachmentsError: undefined,
    shipment: undefined,
    remembered: [],
  };
  const setters = {
    setOrder: (v: ShownOrder | null) => {
      state.order = v;
    },
    setLoadError: (v: string | null) => {
      state.loadError = v;
    },
    setLoading: (v: boolean) => {
      state.loading = v;
    },
    setAttachments: (v: unknown[]) => {
      state.attachments = v;
    },
    setAttachmentsError: (v: string | null) => {
      state.attachmentsError = v;
    },
    setShipment: (v: unknown) => {
      state.shipment = v;
    },
  };
  // The screen's own React.useState initializers: one of each per screen.
  const loads = stateInitializer<() => SequenceGuard>(SCREEN, 'loads', {
    createNewestLoads,
    createSequenceGuard,
  })();
  const attachmentReads = ifPresent(() =>
    stateInitializer<() => SequenceGuard>(SCREEN, 'attachmentReads', { createSequenceGuard })(),
  );
  // The screen's reload: one per screen (its only dependency is `loads`).
  const reload = ifPresent(() => screenCallback<() => Promise<void>>(SCREEN, 'reload', { loads }));
  /** Every load the focus effects started, to wait for in a test. */
  const started: Promise<void>[] = [];

  function render(r: Render): Rendered {
    const {
      canApproveOrders: rpApprove,
      canUpdateItems: rpItems,
      canManagePurchaseOrders: rpBuy,
    } = readinessPermissionsFor(r.role, r.permissions);
    const readAttachments =
      r.readAttachments ??
      (async (): Promise<AttachmentsRead> => ({ attachments: [], error: null }));
    const loadAttachments = screenCallback<() => Promise<void>>(SCREEN, 'loadAttachments', {
      readAttachments,
      attachmentReads,
      ...setters,
    });
    const load = screenCallback<() => Promise<void>>(SCREEN, 'load', {
      ...setters,
      orgId: ORG,
      id: ORDER_ID,
      isUuid,
      loads,
      attachmentReads,
      offline: r.offline ?? false,
      permissionsRead: r.permissionsRead,
      supabase: r.client,
      shouldReadReadiness,
      orderReadinessAudience,
      rpApprove,
      rpItems,
      rpBuy,
      userId,
      role: r.role,
      // Readiness is its own read (order-readiness tests): here it is never answered as checked.
      readOrderReadiness: async () => ({ state: 'failed' }),
      readOrgTimeZone: async () => null,
      needsNeededByZoneRead,
      needsDeliveryRequestData,
      needsOrderWarehouseScope,
      readOrderWarehouseScope,
      readErrorMessage,
      shouldLoadOrderReturns,
      ORDER_RETURNS_SELECT,
      parseOrderReturns,
      ORDER_RETURNS_EXCHANGE_SELECT,
      exchangeItemIdsOf,
      exchangeLinesByReturn,
      api: async () => ({}),
      reconcileReadiness,
      parseCharterAddress,
      isMissingEmailRoutingColumn,
      deliveryRoutingFromOrgRow,
      resolveRequesterLabel,
      profileFromEmbed,
      derivePickSlipStale,
      orderLineItemName,
      readAttachments,
      loadAttachments,
      getOrderShipment: r.getOrderShipment ?? (async () => null),
      rememberOrderView: (
        _user: unknown,
        _org: unknown,
        _id: unknown,
        view: { order: ShownOrder; attachments: unknown[] },
      ) => {
        state.remembered.push(view);
      },
      console: { warn: () => undefined },
    });
    // The layout effect after this render (`load` is new each render here).
    ifPresent(() => layoutEffectCallback<() => void>(SCREEN, { loads, load }))?.();
    // The focus effect is handed a `load` that keeps its promise for the test.
    const tracked = (): Promise<void> => {
      const p = load();
      started.push(p);
      return p;
    };
    const focus = focusEffectCallback<() => void>(SCREEN, { load: tracked, loads });
    return { load, loadAttachments, focus, rpApprove, rpItems };
  }

  /** Waits until every load the focus effects started has ended. */
  async function settled(): Promise<void> {
    for (let seen = -1; seen !== started.length;) {
      seen = started.length;
      await Promise.allSettled(started);
    }
  }

  return { state, loads, reload, render, settled };
}

/** A promise the test resolves when it chooses. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every promise that can settle now settle. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
