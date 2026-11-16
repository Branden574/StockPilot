import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a schedule event, a serial number or a customer
 * account's status changed through the /api/v1 routes leaves one
 * audit_logs row, and for the schedule and serial number changes it is the
 * row the website's action leaves for the same change: the same event,
 * organization, account and metadata. The two differ only in the request's
 * user agent (the audit writer has no other field for where a request came
 * from).
 *
 * The real audit writer (server/services/audit.ts) runs here, over a
 * recording admin client, so each row is checked as it is sent. The services
 * are the real ones too, over a recording database client.
 *
 * An audit row that cannot be written does not undo or refuse the change,
 * through a route or through the website's action: the writer never throws,
 * reports the loss, and the change is answered as made.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  insertAnswer: { error: null } as { error: { message: string; code?: string } | null },
  userAgent: 'StockPilot/1.0 (Bearer client)',
  withContext: vi.fn(),
}));

vi.unmock('@/server/services/audit');
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) =>
      k === 'user-agent' ? h.userAgent : k === 'x-forwarded-for' ? '203.0.113.9' : null,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => {
  const builder = (answer: () => unknown) => {
    const b = {
      abortSignal() {
        return b;
      },
      then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
        return Promise.resolve().then(answer).then(onOk, onErr);
      },
    };
    return b;
  };
  return {
    createAdminClient: () => ({
      from: (table: string) => ({
        insert: (rows: unknown) =>
          builder(() => {
            if (table === 'audit_logs') {
              for (const r of [rows].flat()) h.sent.push(r as Record<string, unknown>);
            }
            return h.insertAnswer;
          }),
        upsert: () => builder(() => h.insertAnswer),
      }),
    }),
  };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: h.withContext,
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { resetAuditLossReportsForTests } from '@/server/services/audit';
import { createScheduleEventAction } from '@/server/actions/schedule';
import {
  addItemSerialsAction,
  deleteItemSerialAction,
  updateItemSerialAction,
} from '@/server/actions/serials';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { PATCH as patchCustomerStatus } from './customers/[id]/status/route';
import { POST as addSerials } from './items/[id]/serials/route';
import { POST as createEvent } from './schedule/route';
import { DELETE as deleteSerial, PATCH as patchSerial } from './serials/[id]/route';

const ORG = 'org-parity';
const USER = 'user-parity';
const WAREHOUSE = '3c1d2e4f-0000-4000-8000-000000000041';
const EVENT = '9e8d7c6b-0000-4000-8000-000000000042';
const ITEM = '1a2b3c4d-0000-4000-8000-000000000043';
const SERIAL = '5e5e5e5e-0000-4000-8000-000000000044';
const CUSTOMER = '6c6c6c6c-0000-4000-8000-000000000045';
const BEARER_CLIENT = 'StockPilot/1.0 (Bearer client)';
const BROWSER = 'Mozilla/5.0 (Macintosh)';

const eventRow = {
  id: EVENT,
  organization_id: ORG,
  title: 'Science night setup',
  starts_at: '2026-12-02T15:00:00.000Z',
  ends_at: null,
  all_day: false,
  location_text: null,
  warehouse_id: WAREHOUSE,
  requester_name: null,
  details: null,
  status: 'scheduled',
  bundle_id: null,
  bundle_quantity: null,
  bundle_warehouse_id: null,
  order_request_id: null,
  created_by: USER,
  updated_by: USER,
  created_at: '2026-11-15T00:00:00.000Z',
  updated_at: '2026-11-15T00:00:00.000Z',
  deleted_users: null,
  warehouse: { name: 'Main' },
};

function context() {
  const stub = makeSupabaseStub({
    'schedule_events.insert': { data: eventRow, error: null },
    'user_profiles.select': { data: [], error: null },
    'inventory_items.select': { data: { id: ITEM }, error: null },
    'warehouses.select': { data: { id: WAREHOUSE }, error: null },
    'serial_registry.select': (call) =>
      call.methods.includes('in')
        ? { data: [], error: null }
        : {
            data: {
              id: SERIAL,
              item_id: ITEM,
              serial_number: 'SN-7',
              current_status: 'available',
              receipt_line_id: null,
            },
            error: null,
          },
    'serial_registry.insert': { data: null, error: null },
    'serial_registry.update': {
      data: { id: SERIAL, item_id: ITEM, serial_number: 'SN-7', current_status: 'rma' },
      error: null,
    },
    'serial_registry.delete': { data: { id: SERIAL }, error: null },
    'customers.select': {
      data: { id: CUSTOMER, name: 'Example Prep', status: 'active' },
      error: null,
    },
    'customers.update': { data: { id: CUSTOMER }, error: null },
  });
  return makeServiceContext(stub.client, {
    organizationId: ORG,
    userId: USER,
    role: 'manager',
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'b2b_portal' as ModuleId]),
  });
}

function json(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  }) as never;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The rows sent while `run` ran: through a route (a Bearer context) or a website action (a cookie context). */
async function rowsSentBy(
  surface: 'route' | 'action',
  run: () => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  h.sent.length = 0;
  h.userAgent = surface === 'route' ? BEARER_CLIENT : BROWSER;
  const ctx = context();
  vi.mocked(withApiContext).mockResolvedValue(surface === 'route' ? (ctx as never) : null);
  h.withContext.mockResolvedValue(ctx);
  await run();
  return [...h.sent];
}

/** A row without what differs by nature: its own id and the user agent. */
function comparable(row: Record<string, unknown>) {
  const { id: _id, user_agent: _ua, ...rest } = row;
  return rest;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.insertAnswer = { error: null };
  resetAuditLossReportsForTests();
});

afterEach(() => {
  resetAuditLossReportsForTests();
});

const CASES = [
  {
    name: 'a schedule event made',
    event: 'schedule.created',
    route: async () => {
      const res = await createEvent(
        json('https://test.local/api/v1/schedule', 'POST', {
          title: 'Science night setup',
          startsAt: '2026-12-02T15:00:00.000Z',
          warehouseId: WAREHOUSE,
        }),
      );
      expect(res.status).toBe(201);
    },
    web: async () => {
      const res = await createScheduleEventAction({
        title: 'Science night setup',
        startsAt: '2026-12-02T15:00:00.000Z',
        warehouseId: WAREHOUSE,
        allDay: false,
        status: 'scheduled',
      });
      expect(res.ok).toBe(true);
    },
  },
  {
    name: 'serial numbers added',
    event: 'item.serials.added',
    route: async () => {
      const res = await addSerials(
        json(`https://test.local/api/v1/items/${ITEM}/serials`, 'POST', {
          warehouseId: WAREHOUSE,
          serials: ['SN-7'],
        }),
        params(ITEM),
      );
      expect(res.status).toBe(201);
    },
    web: async () => {
      const res = await addItemSerialsAction({
        itemId: ITEM,
        warehouseId: WAREHOUSE,
        serials: ['SN-7'],
      });
      expect(res.ok).toBe(true);
    },
  },
  {
    name: "a serial number's status changed",
    event: 'item.serial.updated',
    route: async () => {
      const res = await patchSerial(
        json(`https://test.local/api/v1/serials/${SERIAL}`, 'PATCH', { status: 'rma' }),
        params(SERIAL),
      );
      expect(res.status).toBe(200);
    },
    web: async () => {
      const res = await updateItemSerialAction({ id: SERIAL, status: 'rma' });
      expect(res.ok).toBe(true);
    },
  },
  {
    name: 'a serial number removed',
    event: 'item.serial.deleted',
    route: async () => {
      const res = await deleteSerial(
        json(`https://test.local/api/v1/serials/${SERIAL}`, 'DELETE'),
        params(SERIAL),
      );
      expect(res.status).toBe(200);
    },
    web: async () => {
      const res = await deleteItemSerialAction({ id: SERIAL });
      expect(res.ok).toBe(true);
    },
  },
] as const;

describe('a route and the website action leave the same audit row for the same change', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const routeRows = await rowsSentBy('route', c.route);
    const webRows = await rowsSentBy('action', c.web);

    expect(routeRows).toHaveLength(1);
    expect(webRows).toHaveLength(1);
    const [routeRow] = routeRows;
    const [web] = webRows;
    expect(routeRow).toMatchObject({
      event: c.event,
      organization_id: ORG,
      user_id: USER,
      user_agent: BEARER_CLIENT,
    });
    expect(web).toMatchObject({
      event: c.event,
      organization_id: ORG,
      user_id: USER,
      user_agent: BROWSER,
    });
    expect(comparable(routeRow!)).toEqual(comparable(web!));
  });

  it('a customer account archived through its route leaves one row naming the account, its status before and after, the caller and the request', async () => {
    const rows = await rowsSentBy('route', async () => {
      const res = await patchCustomerStatus(
        json(`https://test.local/api/v1/customers/${CUSTOMER}/status`, 'PATCH', {
          status: 'archived',
        }),
        params(CUSTOMER),
      );
      expect(res.status).toBe(200);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'organization.updated',
      organization_id: ORG,
      user_id: USER,
      user_agent: BEARER_CLIENT,
      metadata: {
        entity_type: 'customer',
        entity_id: CUSTOMER,
        before: { status: 'active' },
        after: { status: 'archived' },
        action: 'customer_archived',
        name: 'Example Prep',
      },
    });
  });

  it('a refused change sends no row', async () => {
    const rows = await rowsSentBy('route', async () => {
      const res = await patchSerial(
        json(`https://test.local/api/v1/serials/${SERIAL}`, 'PATCH', { status: 'lost' }),
        params(SERIAL),
      );
      expect(res.status).toBe(400);
    });
    expect(rows).toEqual([]);
  });

  it('a row the database refuses does not undo or refuse the change, through the route or the website action', async () => {
    h.insertAnswer = { error: { message: 'null value in column', code: '23502' } };
    const routeRows = await rowsSentBy('route', async () => {
      const res = await deleteSerial(
        json(`https://test.local/api/v1/serials/${SERIAL}`, 'DELETE'),
        params(SERIAL),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, itemId: ITEM });
    });
    const webRows = await rowsSentBy('action', async () => {
      const res = await deleteItemSerialAction({ id: SERIAL });
      expect(res.ok).toBe(true);
    });
    // Each sent its one row; neither answer changed when it was refused.
    expect(routeRows).toHaveLength(1);
    expect(webRows).toHaveLength(1);
  });
});
