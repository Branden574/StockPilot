/**
 * Lightweight mock builder for the Supabase JS client used inside tests.
 *
 * The real client is a chainable query builder — `from('x').select('y')
 * .eq(...).order(...).limit(...)` — that resolves to `{ data, error }`.
 * Tests want to verify behavior without a real DB, but mocking every
 * possible chain by hand becomes its own bug surface.
 *
 * `makeQueryStub(rows)` returns a recursive Proxy whose every method
 * call returns itself, except `then` (which makes the chain awaitable
 * and resolves to the configured rows). `count: 'exact'` queries get
 * the same shape.
 *
 * Use cases:
 *   const supabase = makeSupabaseStub({
 *     'inventory_items.select': { data: [{ id: 'a' }], error: null },
 *     'organization_members.select': { data: [{ role: 'admin' }], error: null },
 *   });
 *   const result = await supabase.from('inventory_items').select('*').eq('x', 1);
 *
 * Each tablename.select|insert|update|delete|rpc key maps to a result.
 */

import { vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

export interface QueryResult<T = unknown> {
  data: T;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export interface SupabaseStub {
  /** The actual mock object — typed loosely on purpose. */
  client: any;  
  /** Records every from(table) call. */
  fromCalls: string[];
  /** Records every rpc(name, args) call. */
  rpcCalls: Array<{ name: string; args: unknown }>;
  /** Records the LAST chain of method names per (table, op) — useful
   *  to assert filter logic when a service makes a single query. When
   *  a service issues multiple queries to the same (table, op) within
   *  one call (e.g. paginated list + parallel aggregate), this only
   *  reflects the LAST one to finish recording. For multi-query
   *  assertions, use `chainsAll` below. */
  chains: Map<string, string[]>;
  /** Args passed to each chain method, in order. */
  chainArgs: Map<string, unknown[][]>;
  /** Every chain ever started against a (table, op), in declaration
   *  order. The first chain in each list matches the service's first
   *  `from(table).select(...)` call within a method, the second one
   *  the next, etc. Use this when a test needs to assert about a
   *  specific query in a multi-query method. */
  chainsAll: Map<string, string[][]>;
  /** Args matching chainsAll, same shape. */
  chainArgsAll: Map<string, unknown[][][]>;
}

type ResultMap = Record<string, QueryResult | (() => QueryResult)>;

function pickResult(
  resultMap: ResultMap,
  key: string,
  fallbackKey: string,
): QueryResult {
  const v = resultMap[key] ?? resultMap[fallbackKey];
  if (!v) return { data: null, error: null };
  return typeof v === 'function' ? v() : v;
}

/**
 * Build a fresh Supabase client stub. `results` keys look like:
 *   "<table>.select" | "<table>.insert" | "<table>.update" | "<table>.delete"
 *   "rpc:<function_name>"
 * Missing keys default to `{ data: null, error: null }`.
 */
export function makeSupabaseStub(results: ResultMap = {}): SupabaseStub {
  const fromCalls: string[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const chains = new Map<string, string[]>();
  const chainArgs = new Map<string, unknown[][]>();
  const chainsAll = new Map<string, string[][]>();
  const chainArgsAll = new Map<string, unknown[][][]>();

  function makeChain(table: string): unknown {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const chain: string[] = [];
    const args: unknown[][] = [];
    let registered = false;

    function record(method: string, methodArgs: unknown[]) {
      chain.push(method);
      args.push(methodArgs);
      chains.set(`${table}.${op}`, chain);
      chainArgs.set(`${table}.${op}`, args);
      // Register this chain into chainsAll on first record so callers
      // that issue multiple queries to the same (table, op) get an
      // ordered list. The same `chain`/`args` arrays are mutated as
      // additional methods are recorded, so the entry stays live.
      if (!registered) {
        const all = chainsAll.get(`${table}.${op}`) ?? [];
        all.push(chain);
        chainsAll.set(`${table}.${op}`, all);
        const allArgs = chainArgsAll.get(`${table}.${op}`) ?? [];
        allArgs.push(args);
        chainArgsAll.set(`${table}.${op}`, allArgs);
        registered = true;
      }
    }

    const stub: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === 'then') {
          // Resolve the chain when awaited.
          return (resolve: (v: QueryResult) => void) => {
            resolve(pickResult(results, `${table}.${op}`, `${table}.select`));
          };
        }
        if (prop === 'select') {
          return (...callArgs: unknown[]) => {
            // First call after from() locks op = select unless mutation happened.
            if (chain.length === 0) op = 'select';
            record('select', callArgs);
            return new Proxy(stub, handler);
          };
        }
        if (prop === 'insert') {
          op = 'insert';
          return (...callArgs: unknown[]) => {
            record('insert', callArgs);
            return new Proxy(stub, handler);
          };
        }
        if (prop === 'update') {
          op = 'update';
          return (...callArgs: unknown[]) => {
            record('update', callArgs);
            return new Proxy(stub, handler);
          };
        }
        if (prop === 'delete') {
          op = 'delete';
          return (...callArgs: unknown[]) => {
            record('delete', callArgs);
            return new Proxy(stub, handler);
          };
        }
        if (prop === 'upsert') {
          op = 'insert';
          return (...callArgs: unknown[]) => {
            record('upsert', callArgs);
            return new Proxy(stub, handler);
          };
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => {
            const result = pickResult(
              results,
              `${table}.${op}.${prop}`,
              `${table}.${op}`,
            );
            const data =
              Array.isArray(result.data) && result.data.length > 0
                ? result.data[0]
                : Array.isArray(result.data)
                  ? null
                  : result.data;
            return Promise.resolve({ ...result, data });
          };
        }
        // Generic chainable filter: eq, neq, in, is, gt, gte, lt, lte,
        // like, ilike, contains, order, limit, range, etc.
        return (...callArgs: unknown[]) => {
          record(prop, callArgs);
          return new Proxy(stub, handler);
        };
      },
    };

    return new Proxy(stub, handler);
  }

  const client = {
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      return makeChain(table);
    }),
    rpc: vi.fn((name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(pickResult(results, `rpc:${name}`, `rpc:${name}`));
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'test-user-id', email: 'test@example.com' } },
        error: null,
      })),
      mfa: {
        listFactors: vi.fn(async () => ({
          data: { all: [], totp: [] },
          error: null,
        })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: 'aal1' },
          error: null,
        })),
      },
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ data: { path: 'mock-path' }, error: null })),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://mock/file' } })),
        createSignedUrl: vi.fn(async () => ({
          data: { signedUrl: 'https://mock/signed' },
          error: null,
        })),
        createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      })),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  };

  return { client, fromCalls, rpcCalls, chains, chainArgs, chainsAll, chainArgsAll };
}

/**
 * Convenience constructor for a ServiceContext-shaped object pointing
 * at a stub client. Tests pass this directly into Service constructors:
 *   new InventoryService(makeServiceContext(stub.client));
 */
export function makeServiceContext(
  supabase: unknown,
  overrides: Partial<{
    organizationId: string;
    userId: string;
    role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
    mfaRequired: boolean;
    mfaSatisfied: boolean;
    enabledModules: Set<ModuleId>;
  }> = {},
) {
  return {
    organizationId: overrides.organizationId ?? 'org-test',
    userId: overrides.userId ?? 'user-test',
    role: overrides.role ?? 'admin',
    // Default to MFA-not-required so existing tests don't have to opt
    // out. Tests covering the MFA gate explicitly set the flags.
    mfaRequired: overrides.mfaRequired ?? false,
    mfaSatisfied: overrides.mfaSatisfied ?? true,
    // Default to the FULL charter-school module set — existing service
    // tests represent a grandfathered org with everything enabled, so a
    // newly-added assertModuleEnabled gate is a no-op for them. Tests
    // covering the module gate pass an explicit set that EXCLUDES the
    // module under test.
    enabledModules: overrides.enabledModules ?? new Set<ModuleId>(DEFAULT_MODULE_IDS),

    supabase: supabase as any,
  };
}
