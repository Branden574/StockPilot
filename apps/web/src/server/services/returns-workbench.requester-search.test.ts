import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * B117, the search half (owner, 2026-11-11: "fix that real gap as well").
 *
 * The Returns list now NAMES the member an order was for, read from their
 * profile, because an order a signed-in member places for themselves keeps
 * the person only in `order_requests.requester_user_id`. The search box
 * ("Search RMA, SO number or requester") still matched the view's typed
 * columns only (`requester_name`, `requester_email`), so typing the name the
 * row shows found none of that member's returns.
 *
 * THE RULE NOW: the search text is first resolved to the members of THIS
 * organisation whose profile name or email matches and whose profile the
 * viewer may read (one read, through the viewer's own row access), and the
 * list also matches `requester_user_id` against them, on rows with no typed
 * name. Over 100 members the list is read once per hundred and merged, so a
 * page is still the 25 newest. Over 500 the list searches as before and says
 * so.
 *
 * These tests answer like PostgREST: the fake evaluates the filter the code
 * sent (the or/and tree, ilike, in, the keyset cursor, order and range)
 * against rows, so a row is found only if the real filter finds it.
 *
 * Every name here is made up.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const access = vi.hoisted(() => ({ value: { hasAllAccess: true, writableIds: [] as string[], readableIds: [] as string[] } }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn(async () => access.value) }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = vi.fn(async () => new Map());
  },
}));

import {
  buildReturnListPage,
  compareReturnListRows,
  RETURN_SEARCH_MAX_MEMBERS,
} from './returns-workbench';

const ORG = 'org-test';
const OTHER_ORG = 'org-other';

type Row = Record<string, unknown>;

// ── A PostgREST-like answer for the two reads ──────────────────────────────

/** Split at top-level commas (outside parentheses and double quotes). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (depth !== 0 || quoted) throw new Error(`unbalanced filter: ${s}`);
  out.push(cur);
  return out;
}

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function likeToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'is');
}

/** Timestamps compare as instants, as Postgres compares them. */
function comparable(v: unknown): number | string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const frac = /\.(\d{1,6})/.exec(v)?.[1] ?? '';
    return Date.parse(v.replace(/\.\d+/, '')) * 1000 + Number(frac.padEnd(6, '0'));
  }
  return v as number | string;
}

/** One node of a PostgREST logic tree against a row. Unknown syntax throws. */
function evalNode(node: string, row: Row): boolean {
  const group = /^(and|or)\((.*)\)$/s.exec(node);
  if (group) {
    const parts = splitTop(group[2] as string).map((p) => evalNode(p, row));
    return group[1] === 'and' ? parts.every(Boolean) : parts.some(Boolean);
  }
  const m = /^([a-z_]+)\.(ilike|eq|in|lt|gt|is)\.(.*)$/s.exec(node);
  if (!m) throw new Error(`cannot evaluate filter node: ${node}`);
  const [, col, op, raw] = m as unknown as [string, string, string, string];
  if (!(col in row)) throw new Error(`filter names a column the view row lacks: ${col}`);
  const value = row[col];
  switch (op) {
    case 'ilike':
      return typeof value === 'string' && likeToRegExp(raw).test(value);
    case 'eq':
      return value !== null && String(value) === unquote(raw);
    case 'in': {
      const list = /^\((.*)\)$/s.exec(raw);
      if (!list) throw new Error(`bad in list: ${raw}`);
      return value !== null && splitTop(list[1] as string).map(unquote).includes(String(value));
    }
    case 'lt':
      return value !== null && comparable(value) < comparable(unquote(raw));
    case 'gt':
      return value !== null && comparable(value) > comparable(unquote(raw));
    default:
      if (raw === 'null') return value === null;
      if (raw === 'true') return value === true;
      throw new Error(`cannot evaluate is.${raw}`);
  }
}

function applyWindow(call: MockCall, rows: Row[]): Row[] {
  const keys: Array<{ col: string; ascending: boolean }> = [];
  let from = 0;
  let to = 999;
  call.methods.forEach((method, i) => {
    const [a, b] = (call.args[i] ?? []) as [unknown, unknown];
    if (method === 'order') keys.push({ col: a as string, ascending: (b as { ascending?: boolean } | undefined)?.ascending !== false });
    if (method === 'range') {
      from = Number(a);
      to = Number(b);
    }
    if (method === 'limit') to = from + Number(a) - 1;
  });
  const sorted = [...rows].sort((x, y) => {
    for (const { col, ascending } of keys) {
      const l = comparable(x[col]);
      const r = comparable(y[col]);
      const c = l < r ? -1 : l > r ? 1 : 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
  return sorted.slice(from, to + 1);
}

/** `return_overview`, answering the filters the list sent. */
function overviewAnswer(rows: Row[]) {
  return (call: MockCall) => {
    let out = rows;
    call.methods.forEach((method, i) => {
      const [a, b, c] = (call.args[i] ?? []) as [unknown, unknown, unknown];
      switch (method) {
        case 'select':
        case 'order':
        case 'range':
          break;
        case 'eq':
          out = out.filter((r) => r[a as string] === b);
          break;
        case 'in':
          out = out.filter((r) => (b as unknown[]).includes(r[a as string]));
          break;
        case 'not':
          if (b !== 'is' || c !== null) throw new Error('unexpected .not()');
          out = out.filter((r) => r[a as string] !== null);
          break;
        case 'or':
          out = out.filter((r) => evalNode(`or(${a as string})`, r));
          break;
        default:
          throw new Error(`return_overview fake cannot evaluate .${method}()`);
      }
    });
    return { data: applyWindow(call, out), error: null };
  };
}

type Member = {
  organization_id: string;
  user_id: string;
  full_name: string | null;
  email: string;
  /** False = the viewer's row access hides this profile (the inner embed drops the row). */
  readable?: boolean;
};

/** `organization_members` with the member's profile embedded (inner), answering the filters sent. */
function membersAnswer(members: Member[]) {
  return (call: MockCall) => {
    const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
    if (!/user_profiles:user_id!inner/.test(select)) throw new Error(`the profile embed must be inner: ${select}`);
    let out = members.filter((m) => m.readable !== false);
    call.methods.forEach((method, i) => {
      const [a, b] = (call.args[i] ?? []) as [unknown, unknown];
      switch (method) {
        case 'select':
        case 'order':
        case 'range':
        case 'limit':
          break;
        case 'eq':
          out = out.filter((r) => (r as unknown as Row)[a as string] === b);
          break;
        case 'or':
          if ((b as { referencedTable?: string } | undefined)?.referencedTable !== 'user_profiles') {
            throw new Error('the name filter must be scoped to the embedded profile');
          }
          out = out.filter((r) => evalNode(`or(${a as string})`, { full_name: r.full_name, email: r.email }));
          break;
        default:
          throw new Error(`organization_members fake cannot evaluate .${method}()`);
      }
    });
    const shaped = out.map((m) => ({
      organization_id: m.organization_id,
      user_id: m.user_id,
      user_profiles: { full_name: m.full_name, email: m.email },
    }));
    return { data: applyWindow(call, shaped), error: null };
  };
}

// ── Data ───────────────────────────────────────────────────────────────────

const uid = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
const rid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;

/** A view row; `n` orders it (a larger n is newer). A self-placed order by default. */
function overview(n: number, over: Row = {}): Row {
  return {
    id: rid(n),
    organization_id: ORG,
    return_number: `RMA-20261101-${String(n).padStart(6, '0')}`,
    status: 'requested',
    source: 'internal',
    reason_code: null,
    order_request_id: '22222222-2222-4222-8222-222222222222',
    order_number: 1000 + n,
    requester_name: null,
    requester_email: null,
    requester_user_id: null,
    requested_by: null,
    deleted_users: null,
    created_at: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString().replace('Z', '+00:00'),
    approved_at: null,
    waiting_days: null,
    line_count: 0,
    unit_count: 0,
    lines: [],
    kind: 'return',
    exchange_status: 'none',
    requested_short: false,
    replacement_order_number: null,
    replacement_status: null,
    replacement_owed: null,
    ...over,
  };
}

const ROBIN = uid(1);
const DANA = uid(2);
const HIDDEN = uid(3);
const ELSEWHERE = uid(4);

const MEMBERS: Member[] = [
  { organization_id: ORG, user_id: ROBIN, full_name: 'Robin Vale', email: 'rv.front-desk@example.com' },
  { organization_id: ORG, user_id: DANA, full_name: 'Dana Keeler', email: 'dana.keeler@example.com' },
  // A member whose profile this viewer may not read.
  { organization_id: ORG, user_id: HIDDEN, full_name: 'Quill Hidden', email: 'quill.hidden@example.com', readable: false },
  // A member of ANOTHER organisation the viewer also belongs to (so the profile is readable).
  { organization_id: OTHER_ORG, user_id: ELSEWHERE, full_name: 'Robin Vale', email: 'robin.elsewhere@example.com' },
];

const ROWS: Row[] = [
  // Robin placed two orders for themselves; one return was opened by staff, one by Robin.
  overview(1, { requester_user_id: ROBIN, requested_by: DANA }),
  overview(2, { requester_user_id: ROBIN, requested_by: ROBIN, source: 'requester' }),
  // Dana placed one for herself.
  overview(3, { requester_user_id: DANA }),
  // Placed for someone: a typed name, no member.
  overview(4, { requester_name: 'Sam Porter', requester_email: 'sam.porter@example.com' }),
  // A public-link order: typed email only.
  overview(5, { requester_email: 'lee.public@example.com' }),
  // The hidden member's own order.
  overview(6, { requester_user_id: HIDDEN }),
  // Another organisation's return, for its own member of the same name.
  overview(7, { organization_id: OTHER_ORG, requester_user_id: ELSEWHERE }),
  // Another organisation's return with a typed name.
  overview(8, { organization_id: OTHER_ORG, requester_name: 'Robin Vale' }),
];

function setup(rows: Row[] = ROWS, members: Member[] = MEMBERS, over: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'return_overview.select': overviewAnswer(rows),
    'organization_members.select': membersAnswer(members),
    'inventory_items.select': { data: [], error: null },
    'user_profiles.select': (call: MockCall) => {
      const ids = (call.args[call.methods.indexOf('in')]?.[1] ?? []) as string[];
      return {
        data: members
          .filter((m) => m.readable !== false && ids.includes(m.user_id))
          .map((m) => ({ id: m.user_id, full_name: m.full_name, email: m.email })),
        error: null,
      };
    },
    ...over,
  } as never);
  const ctx = makeServiceContext(stub.client, {
    role: 'owner',
    enabledModules: new Set<ModuleId>(['returns', 'orders'] as ModuleId[]),
  });
  return { stub, ctx };
}

async function search(q: string, rows?: Row[], members?: Member[], over?: Record<string, unknown>) {
  const { stub, ctx } = setup(rows, members, over);
  const page = await buildReturnListPage(ctx as never, { filter: 'all', q });
  return { page, stub, ids: page.rows.map((r) => r.id) };
}

/** Every `.or()` string the list sent to the view. */
function overviewFilters(stub: ReturnType<typeof setup>['stub']): string[] {
  const out: string[] = [];
  (stub.chainsAll.get('return_overview.select') ?? []).forEach((methods, c) => {
    methods.forEach((m, i) => {
      if (m === 'or') out.push(String(stub.chainArgsAll.get('return_overview.select')?.[c]?.[i]?.[0]));
    });
  });
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  access.value = { hasAllAccess: true, writableIds: [], readableIds: [] };
});

describe('B117 search: a member who placed their own order is found by the name the row shows', () => {
  it.each([
    ['first name', 'robin'],
    ['last name', 'Vale'],
    ['part of the name', 'bin va'],
    ['the whole name, any case', 'ROBIN VALE'],
    ['email', 'rv.front-desk@example.com'],
    ['part of the email', 'front-desk'],
  ])('by %s', async (_label, q) => {
    const { page, ids } = await search(q);
    // Newest first; both of Robin's returns, whoever opened them, and nothing else.
    expect(ids).toEqual([rid(2), rid(1)]);
    expect(page.rows.map((r) => r.requesterName)).toEqual(['Robin Vale', 'Robin Vale']);
    expect(page.nextCursor).toBeNull();
    expect(page.requesterSearch).toBe('full');
  });

  it('asks for the people once, in this organisation only, through the viewer own session', async () => {
    const { stub } = await search('robin');
    const chains = stub.chainsAll.get('organization_members.select') ?? [];
    expect(chains).toHaveLength(1);
    const args = stub.chainArgsAll.get('organization_members.select')?.[0] ?? [];
    const eqs = (chains[0] ?? []).map((m, i) => (m === 'eq' ? args[i] : null)).filter(Boolean);
    expect(eqs).toContainEqual(['organization_id', ORG]);
    // One read of the view: a handful of people fit one request.
    expect(stub.chainsAll.get('return_overview.select')).toHaveLength(1);
  });

  it('makes no people read when nothing is searched', async () => {
    const { stub, ctx } = setup();
    const page = await buildReturnListPage(ctx as never, { filter: 'all' });
    expect(page.rows).toHaveLength(6);
    expect(stub.fromCalls).not.toContain('organization_members');
    expect(page.requesterSearch).toBe('full');
  });
});

describe('B117 search: everything it found before, it still finds', () => {
  it('an order placed for someone is found by its typed name and typed email', async () => {
    expect((await search('sam')).ids).toEqual([rid(4)]);
    expect((await search('porter@example')).ids).toEqual([rid(4)]);
    expect((await search('lee.public')).ids).toEqual([rid(5)]);
  });

  it('an email written with a plus sign is found whole, on a member profile and on a typed email', async () => {
    const members: Member[] = [
      ...MEMBERS,
      { organization_id: ORG, user_id: uid(9), full_name: 'Pat Mora', email: 'pat+returns@example.com' },
    ];
    const rows = [
      ...ROWS,
      overview(9, { requester_user_id: uid(9) }),
      overview(10, { requester_email: 'lee+orders@example.com' }),
    ];
    const member = await search('pat+returns@example.com', rows, members);
    expect(member.page.q).toBe('pat+returns@example.com');
    expect(member.ids).toEqual([rid(9)]);
    expect(member.page.requesterSearch).toBe('full');
    expect((await search('lee+orders@example.com', rows, members)).ids).toEqual([rid(10)]);
    // The plus is a plain character: it does not match an address without it.
    expect((await search('pat+nobody@example.com', rows, members)).ids).toEqual([]);
  });

  it('an RMA number and an SO number', async () => {
    expect((await search('RMA-20261101-000003')).ids).toEqual([rid(3)]);
    expect((await search('SO-001005')).ids).toEqual([rid(5)]);
    expect((await search('1005')).ids).toEqual([rid(5)]);
  });

  it('no match is an empty page, not an error', async () => {
    const { page } = await search('zzz nobody');
    expect(page).toMatchObject({ rows: [], nextCursor: null, requesterSearch: 'full', q: 'zzz nobody' });
  });

  it('a name that is also RMA text finds both kinds of row, each once, newest first', async () => {
    const members: Member[] = [
      ...MEMBERS,
      { organization_id: ORG, user_id: uid(9), full_name: 'Irma Stone', email: 'i.stone@example.com' },
    ];
    const rows = [...ROWS, overview(9, { requester_user_id: uid(9) })];
    // "rma" is in every return number and in Irma's name.
    const { ids } = await search('rma', rows, members);
    expect(ids).toEqual([rid(9), rid(6), rid(5), rid(4), rid(3), rid(2), rid(1)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the filters still narrow a name search', async () => {
    const rows = [
      overview(1, { requester_user_id: ROBIN, status: 'closed' }),
      overview(2, { requester_user_id: ROBIN, status: 'requested' }),
    ];
    const { stub, ctx } = setup(rows);
    const page = await buildReturnListPage(ctx as never, { filter: 'closed', q: 'robin' });
    expect(page.rows.map((r) => r.id)).toEqual([rid(1)]);
    expect(stub.fromCalls).toContain('organization_members');
  });
});

describe('B117 search: who may be found', () => {
  it('never returns another organisation returns, by member name or by typed name', async () => {
    const { ids, stub } = await search('robin vale');
    expect(ids).toEqual([rid(2), rid(1)]);
    // The other organisation's member is not even put in the filter.
    expect(overviewFilters(stub).join(' ')).not.toContain(ELSEWHERE);
  });

  it('a member whose profile the viewer may not read is not found by name, and nothing says they exist', async () => {
    const hit = await search('quill');
    expect(hit.page).toMatchObject({ rows: [], nextCursor: null, requesterSearch: 'full' });
    // The same answer as a name nobody has.
    const miss = await search('qqqqq');
    expect({ ...hit.page, q: '' }).toEqual({ ...miss.page, q: '' });
    expect(overviewFilters(hit.stub).join(' ')).not.toContain(HIDDEN);
  });

  it('a member is not matched on an order that carries a typed name (the row shows the typed name)', async () => {
    const rows = [overview(1, { requester_user_id: ROBIN, requester_name: 'Sam Porter' })];
    expect((await search('robin', rows)).ids).toEqual([]);
    expect((await search('sam', rows)).ids).toEqual([rid(1)]);
  });
});

describe('B117 search: typed text cannot change the filter', () => {
  it.each([
    'x,organization_id.neq.none',
    'x),or(organization_id.neq.none',
    'robin%',
    'robin\\',
    '"robin"',
    `robin,requester_user_id.in.(${ELSEWHERE})`,
    'robin*',
    "robin'; drop table returns; --",
    'robin+x,organization_id.neq.none',
  ])('%s', async (q) => {
    const { page, stub } = await search(q);
    // Only this organisation's rows, whatever was typed.
    const own = new Set(ROWS.filter((r) => r.organization_id === ORG).map((r) => r.id));
    for (const r of page.rows) expect(own.has(r.id)).toBe(true);
    // The term reached both reads holding no filter syntax.
    expect(page.q).toMatch(/^[\p{L}\p{N}\s@._+-]*$/u);
    const memberOr = (stub.chainsAll.get('organization_members.select') ?? []).flatMap((methods, c) =>
      methods.flatMap((m, i) => (m === 'or' ? [String(stub.chainArgsAll.get('organization_members.select')?.[c]?.[i]?.[0])] : [])),
    );
    for (const f of memberOr) {
      expect(f).toBe(`full_name.ilike.%${page.q}%,email.ilike.%${page.q}%`);
    }
    // The view's filter is exactly the three typed terms around the cleaned
    // text, plus at most the member clause, whose list holds only ids of this
    // organisation's readable members: nothing typed became filter syntax.
    const allowed = new Set(MEMBERS.filter((m) => m.organization_id === ORG && m.readable !== false).map((m) => m.user_id));
    const filters = overviewFilters(stub);
    expect(filters).toHaveLength(1);
    for (const f of filters) {
      expect(f).not.toMatch(/["\\*]/);
      const typed = `return_number.ilike.%${page.q}%,requester_name.ilike.%${page.q}%,requester_email.ilike.%${page.q}%`;
      expect(f.startsWith(`and(or(${typed}`)).toBe(true);
      const rest = f.slice(`and(or(${typed}`.length);
      const m = /^(?:,and\(requester_user_id\.in\.\(([0-9a-f,-]+)\),requester_name\.is\.null\))?\)\)$/.exec(rest);
      expect(m, rest).not.toBeNull();
      for (const id of (m?.[1] ?? '').split(',').filter(Boolean)) expect(allowed.has(id)).toBe(true);
    }
  });

  it('text that is only punctuation is no search at all', async () => {
    const { page, stub } = await search('%,()\\');
    expect(page.q).toBe('');
    expect(page.rows).toHaveLength(6);
    expect(stub.fromCalls).not.toContain('organization_members');
  });
});

describe('B117 search: many matching people', () => {
  /** `count` members all called "Avery <n>", each with one return against their own order. */
  function crowd(count: number) {
    const members: Member[] = [];
    const rows: Row[] = [];
    for (let n = 1; n <= count; n += 1) {
      members.push({ organization_id: ORG, user_id: uid(1000 + n), full_name: `Avery ${n}`, email: `member${n}@example.com` });
      rows.push(overview(n, { requester_user_id: uid(1000 + n) }));
    }
    return { members, rows };
  }

  it('250 matching people: every page is exact, in order, with nothing twice and nothing missing', async () => {
    const { members, rows } = crowd(250);
    // Also one typed-name row that matches in every one of the three reads.
    rows.push(overview(251, { requester_name: 'Avery Typed' }));
    const { stub, ctx } = setup(rows, members);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await buildReturnListPage(ctx as never, { filter: 'all', q: 'avery', cursor });
      expect(page.requesterSearch).toBe('full');
      expect(page.rows.length).toBeLessThanOrEqual(25);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 30);
    const expected = Array.from({ length: 251 }, (_, i) => rid(251 - i));
    expect(seen).toEqual(expected);
    expect(pages).toBe(11);
    // 250 people ride in three reads of at most 100 each, per page.
    const filters = overviewFilters(stub);
    expect(filters).toHaveLength(pages * 3);
    for (const f of filters) {
      const list = /requester_user_id\.in\.\(([^)]*)\)/.exec(f)?.[1] ?? '';
      expect(list.split(',').length).toBeLessThanOrEqual(100);
    }
  });

  it('the oldest-first view (waiting for return) pages a crowd exactly too', async () => {
    const { members, rows } = crowd(130);
    const approved: Row[] = rows.map((r, i) => ({
      ...r,
      status: 'approved',
      // Different fraction lengths, as PostgREST prints them.
      approved_at: i % 2 === 0 ? `2026-10-05T00:00:${String(i % 60).padStart(2, '0')}+00:00` : `2026-10-05T00:00:${String(i % 60).padStart(2, '0')}.5+00:00`,
    }));
    const { ctx } = setup(approved, members);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await buildReturnListPage(ctx as never, { filter: 'waiting_for_return', q: 'avery', cursor });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 30);
    const expected = [...approved]
      .sort((a, b) => compareReturnListRows(a as never, b as never, 'approved_at', true))
      .map((r) => r.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(130);
  });

  it(`at the cap (${RETURN_SEARCH_MAX_MEMBERS} people) the search is still exact`, async () => {
    const { members, rows } = crowd(RETURN_SEARCH_MAX_MEMBERS);
    const { page } = await search('avery', rows, members);
    expect(page.requesterSearch).toBe('full');
    expect(page.rows.map((r) => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => rid(RETURN_SEARCH_MAX_MEMBERS - i)));
  });

  it('over the cap the search matches as before, puts nobody in the filter, and says it was limited', async () => {
    const { members, rows } = crowd(RETURN_SEARCH_MAX_MEMBERS + 1);
    rows.push(overview(9001, { requester_name: 'Avery Typed' }));
    const { page, stub } = await search('avery', rows, members);
    expect(page.requesterSearch).toBe('too_many');
    // The typed name is still found; the self-placed orders are not, and the page says so.
    expect(page.rows.map((r) => r.id)).toEqual([rid(9001)]);
    expect(overviewFilters(stub).join(' ')).not.toContain('requester_user_id');
    expect(stub.chainsAll.get('return_overview.select')).toHaveLength(1);
  });

  it('a narrower search under the cap is exact again', async () => {
    const { members, rows } = crowd(RETURN_SEARCH_MAX_MEMBERS + 1);
    const { page } = await search('avery 500', rows, members);
    expect(page.requesterSearch).toBe('full');
    expect(page.rows.map((r) => r.id)).toEqual([rid(500)]);
  });
});

describe('B117 search: a failed people read', () => {
  it('searches as before, reports it, says so, and does not fail the list', async () => {
    const { page, stub } = await search('sam', ROWS, MEMBERS, {
      'organization_members.select': { data: null, error: { message: 'boom' } },
    });
    expect(page.rows.map((r) => r.id)).toEqual([rid(4)]);
    expect(page.requesterSearch).toBe('unavailable');
    expect(reportError).toHaveBeenCalled();
    expect(overviewFilters(stub).join(' ')).not.toContain('requester_user_id');
  });
});

describe('compareReturnListRows: the order the database gives', () => {
  const row = (created_at: string, id: string) => ({ id, created_at, approved_at: created_at });
  it('compares instants, not text, down to the microsecond, then the id', () => {
    const a = row('2026-10-05T00:00:01+00:00', rid(1));
    const b = row('2026-10-05T00:00:01.5+00:00', rid(2));
    const c = row('2026-10-05T00:00:01.500001+00:00', rid(3));
    const d = row('2026-10-05T00:00:01.500001+00:00', rid(4));
    const asc = [d, c, b, a].sort((x, y) => compareReturnListRows(x as never, y as never, 'created_at', true));
    expect(asc.map((r) => r.id)).toEqual([rid(1), rid(2), rid(3), rid(4)]);
    const desc = [a, b, c, d].sort((x, y) => compareReturnListRows(x as never, y as never, 'created_at', false));
    expect(desc.map((r) => r.id)).toEqual([rid(4), rid(3), rid(2), rid(1)]);
  });
});
