// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addVendorRiskDays,
  DEFAULT_MODULE_IDS,
  VENDOR_RISK_ACT_AS_REFUSAL,
  VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  VENDOR_RISK_REFUSAL_WORDS,
  vendorRiskQuestionsFor,
  type ModuleId,
  type VendorRiskAnswers,
} from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type QueryResult,
  servedLikePostgrest,
} from '@/test/supabase-mock';

/**
 * Security invariant: vendor risk reviews (part 7 of the security tools),
 * server/services/supplier-risk.ts.
 *   - THE GATE, asked before anything is read or sent, for every read and
 *     every write: the Suppliers module, then the authenticator step, then
 *     the role (owners and admins only; managers, staff and viewers are
 *     refused). Then the database's function, with the context's own
 *     organization and nothing from the request.
 *   - A SUPPORT (act-as) SEAT reads and never writes: refused here before
 *     anything is sent, and so is a seat that could not be read.
 *   - COULD NOT CHECK IS NEVER NOTHING: a missing function (0481 not live), a
 *     failed or unreadable read answers could_not_check, never an empty list;
 *     a write to a missing function says nothing was saved.
 *   - Every refusal of 0481 maps to core's words by the hint alone; the
 *     error's own text is never read.
 *   - Nothing is written to the shared audit log (a manager reads it): the
 *     record is the review tables, read by owners and admins only.
 */

const h = vi.hoisted(() => ({
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  report: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('./audit', () => ({ audit: h.audit }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));

import { ServiceError } from './context';
import {
  sameInstant,
  SUPPLIER_RISK_EVENTS_PAGE,
  SUPPLIER_RISK_BUSY,
  SUPPLIER_RISK_DRAFT_MOVED,
  SUPPLIER_RISK_FORBIDDEN,
  SUPPLIER_RISK_NOTHING_SAVED,
  SUPPLIER_RISK_REGISTER_MAX_PAGES,
  SUPPLIER_RISK_REGISTER_PAGE_ROWS,
  SUPPLIER_RISK_SEAT_UNKNOWN,
  SupplierRiskService,
  supplierRiskRefusalOf,
  type SupplierRiskFinishInput,
} from './supplier-risk';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN = '22222222-2222-4222-8222-222222222222';
const SUPPLIER = '5a5a5a5a-0000-4000-8000-000000000001';
const REVIEW = 'e1e1e1e1-0000-4000-8000-000000000001';
const DRAFT = 'e1e1e1e1-0000-4000-8000-000000000002';
const ITEM = '17e17e17-0000-4000-8000-000000000001';
const DRAFT_AT = '2026-11-27T10:00:00.123456+00:00';
const REASON = 'The vendor showed us a signed letter from their auditor this week.';

type Results = Record<string, QueryResult | ((call: MockCall) => QueryResult)>;

const memberRows = (impersonation: string | null = null) => ({
  data: [{ impersonation_expires_at: impersonation }],
  error: null,
});

/** The member's own seat read (select impersonation_expires_at), or the owners-and-admins list. */
function membersAnswer(seat: QueryResult, people: QueryResult = { data: [], error: null }) {
  return (call: MockCall): QueryResult => {
    const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
    return select.includes('impersonation_expires_at') && !select.includes('user_id')
      ? seat
      : people;
  };
}

function setup(
  results: Results = {},
  ctx: Parameters<typeof makeServiceContext>[1] = {},
  seat: QueryResult = memberRows(),
) {
  const stub = makeSupabaseStub({
    'organization_members.select': membersAnswer(seat),
    ...results,
  });
  const svc = new SupplierRiskService(
    makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: ME,
      role: 'admin',
      ...ctx,
    }) as never,
  );
  return { stub, svc };
}

/** Every question asked at the staff level, answered Not shown to us (no date needed). */
function allNotShown(): VendorRiskAnswers {
  const out: VendorRiskAnswers = {};
  for (const q of vendorRiskQuestionsFor('staff')) out[q.key] = { answer: 'not_shown' };
  return out;
}

function finishInput(over: Partial<SupplierRiskFinishInput> = {}): SupplierRiskFinishInput {
  return {
    supplierId: SUPPLIER,
    dataLevel: 'staff',
    answers: allNotShown() as SupplierRiskFinishInput['answers'],
    nextReviewOn: null,
    overrideResult: null,
    overrideReason: null,
    items: [],
    draftUpdatedAt: DRAFT_AT,
    ...over,
  };
}

const historyWithDraft = (updatedAt: string | null = DRAFT_AT): QueryResult => ({
  data: [
    { review_id: DRAFT, version: 2, status: 'draft', is_current: false, updated_at: updatedAt },
    { review_id: REVIEW, version: 1, status: 'final', is_current: true, result: 'approve' },
  ],
  error: null,
});

const finaliseAnswer = (over: Record<string, unknown> = {}): QueryResult => ({
  data: {
    review_id: DRAFT,
    version: 2,
    superseded_review_id: REVIEW,
    computed_result: 'do_not_use',
    override_result: null,
    result: 'do_not_use',
    next_review_on: '2027-11-27',
    items: 0,
    ...over,
  },
  error: null,
});

const reviewWithItem = (
  over: Record<string, unknown> = {},
  item: Record<string, unknown> = {},
): QueryResult => ({
  data: {
    id: REVIEW,
    supplier_id: SUPPLIER,
    supplier_name: 'Example Supply Co',
    version: 1,
    status: 'final',
    is_current: true,
    data_level: 'staff',
    answers: {},
    items: [
      {
        id: ITEM,
        review_id: REVIEW,
        question_key: 'breach_notice',
        answer: 'no',
        severity: 'high',
        finding: 'No breach notice clause.',
        action: 'Ask for one.',
        owner_user_id: ME,
        due_on: '2026-12-31',
        status: 'open',
        ...item,
      },
    ],
    ...over,
  },
  error: null,
});

const itemAnswer = (over: Record<string, unknown> = {}): QueryResult => ({
  data: {
    id: ITEM,
    review_id: REVIEW,
    question_key: 'breach_notice',
    status: 'accepted',
    owner_user_id: OTHER_ADMIN,
    due_on: '2027-01-31',
    finding: 'No breach notice clause.',
    action: 'Ask for one.',
    ...over,
  },
  error: null,
});

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  h.audit.mockClear();
  h.report.mockClear();
});

/** Every method, each called with an argument it would accept. */
const EVERY_METHOD: Array<[string, (s: SupplierRiskService) => Promise<unknown>]> = [
  ['register', (s) => s.register()],
  ['history', (s) => s.history(SUPPLIER)],
  ['review', (s) => s.review(REVIEW)],
  ['listEvents', (s) => s.listEvents(SUPPLIER, null)],
  ['latest', (s) => s.latest(SUPPLIER)],
  ['ownersAndAdmins', (s) => s.ownersAndAdmins()],
  ['seat', (s) => s.seat()],
  ['saveDraft', (s) => s.saveDraft({ supplierId: SUPPLIER, dataLevel: 'staff', answers: {} })],
  ['finish', (s) => s.finish(finishInput())],
  ['discardDraft', (s) => s.discardDraft(SUPPLIER)],
  [
    'updateItem',
    (s) =>
      s.updateItem({
        reviewId: REVIEW,
        itemId: ITEM,
        status: 'in_progress',
        ownerUserId: null,
        dueOn: null,
        action: null,
        reason: null,
      }),
  ],
];

describe('the gate: the module, then the authenticator step, then owners and admins', () => {
  const noSuppliers = new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'suppliers'));

  it.each(EVERY_METHOD)(
    '%s: the Suppliers module off is refused before anything is read',
    async (_n, call) => {
      const { stub, svc } = setup({}, { enabledModules: noSuppliers });
      const e = await refusal(call(svc));
      expect(e.code).toBe('module_disabled');
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it.each(EVERY_METHOD)(
    '%s: the authenticator step owed is refused before anything is read',
    async (_n, call) => {
      const { stub, svc } = setup({}, { mfaRequired: true, mfaSatisfied: false });
      const e = await refusal(call(svc));
      expect(e.code).toBe('forbidden');
      expect(e.details?.reason).toBe('mfa_required');
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it('the authenticator step is asked before the role (a manager owing it is sent to it first)', async () => {
    const { svc } = setup({}, { role: 'manager', mfaRequired: true, mfaSatisfied: false });
    expect((await refusal(svc.register())).details?.reason).toBe('mfa_required');
  });

  it('an enrolled member owing the code gets aal2_required', async () => {
    const stub = makeSupabaseStub({});
    const ctx = {
      ...makeServiceContext(stub.client, {
        organizationId: ORG,
        mfaRequired: true,
        mfaSatisfied: false,
      }),
      mfaEnrolled: true,
    };
    const e = await refusal(new SupplierRiskService(ctx as never).register());
    expect(e.details?.reason).toBe('aal2_required');
    expect(stub.rpcCalls).toEqual([]);
  });

  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it.each(EVERY_METHOD)(`%s: a ${role} is refused before anything is read`, async (_n, call) => {
      const { stub, svc } = setup({}, { role });
      const e = await refusal(call(svc));
      expect(e.code).toBe('forbidden');
      expect(e.message).toBe(SUPPLIER_RISK_FORBIDDEN);
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    });
  }

  for (const role of ['owner', 'admin'] as const) {
    it(`an ${role} reads the register, with the context's own organization`, async () => {
      const { stub, svc } = setup(
        { 'rpc:supplier_risk_register': { data: [], error: null } },
        { role },
      );
      expect(await svc.register()).toEqual({ state: 'ok', value: [], complete: true });
      expect(stub.rpcCalls).toEqual([
        { name: 'supplier_risk_register', args: { p_organization_id: ORG } },
      ]);
    });
  }

  it('every write sends the context organization, never one from the request', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_draft_save': { data: { review_id: DRAFT, version: 2 }, error: null },
      'rpc:supplier_risk_history': historyWithDraft(),
      'rpc:supplier_risk_finalise': finaliseAnswer(),
      'rpc:supplier_risk_draft_discard': { data: true, error: null },
      'rpc:supplier_risk_review': reviewWithItem(),
      'rpc:supplier_risk_item_update': itemAnswer({ status: 'in_progress' }),
    });
    await svc.saveDraft({ supplierId: SUPPLIER, dataLevel: 'staff', answers: {} });
    await svc.finish(finishInput());
    await svc.discardDraft(SUPPLIER);
    await svc.updateItem({
      reviewId: REVIEW,
      itemId: ITEM,
      status: 'in_progress',
      ownerUserId: null,
      dueOn: null,
      action: null,
      reason: null,
    });
    for (const c of stub.rpcCalls) {
      expect((c.args as Record<string, unknown>).p_organization_id, c.name).toBe(ORG);
    }
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([
      'supplier_risk_draft_save',
      'supplier_risk_history',
      'supplier_risk_finalise',
      'supplier_risk_draft_discard',
      'supplier_risk_review',
      'supplier_risk_item_update',
    ]);
  });
});

describe('the support (act-as) seat reads and never writes', () => {
  const WRITES = EVERY_METHOD.filter(([n]) =>
    ['saveDraft', 'finish', 'discardDraft', 'updateItem'].includes(n),
  );

  it.each(WRITES)(
    '%s: a support seat is refused with the act-as words before anything is sent',
    async (_n, call) => {
      const { stub, svc } = setup({}, {}, memberRows('2026-11-27T12:00:00Z'));
      const e = await refusal(call(svc));
      expect(e.code).toBe('forbidden');
      expect(e.message).toBe(VENDOR_RISK_ACT_AS_REFUSAL_WORDS);
      expect(e.details?.reason).toBe(VENDOR_RISK_ACT_AS_REFUSAL);
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it.each(WRITES)('%s: a seat that could not be read refuses, nothing sent', async (_n, call) => {
    const { stub, svc } = setup({}, {}, { data: null, error: { message: 'x', code: '57014' } });
    const e = await refusal(call(svc));
    expect(e.code).toBe('conflict');
    expect(e.message).toBe(SUPPLIER_RISK_SEAT_UNKNOWN);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('no membership row is an unknown seat, never a member', async () => {
    const { svc } = setup({}, {}, { data: [], error: null });
    expect(await svc.seat()).toBe('unknown');
  });

  it("reads the caller's own membership row in the context's organization", async () => {
    const { stub, svc } = setup();
    expect(await svc.seat()).toBe('member');
    const args = stub.chainArgs.get('organization_members.select') ?? [];
    expect(args).toContainEqual(['organization_id', ORG]);
    expect(args).toContainEqual(['user_id', ME]);
  });

  it('a support seat still reads the register', async () => {
    const { svc } = setup(
      { 'rpc:supplier_risk_register': { data: [], error: null } },
      {},
      memberRows('2026-11-27T12:00:00Z'),
    );
    expect(await svc.seat()).toBe('support');
    expect((await svc.register()).state).toBe('ok');
  });
});

describe('could not check is never nothing', () => {
  const READS: Array<[string, string, (s: SupplierRiskService) => Promise<unknown>]> = [
    ['register', 'supplier_risk_register', (s) => s.register()],
    ['history', 'supplier_risk_history', (s) => s.history(SUPPLIER)],
    ['review', 'supplier_risk_review', (s) => s.review(REVIEW)],
    ['listEvents', 'supplier_risk_events', (s) => s.listEvents(SUPPLIER, null)],
  ];

  for (const code of ['PGRST202', '42883']) {
    it.each(READS)(`%s: a missing function (${code}) is could_not_check`, async (_n, fn, call) => {
      const { svc } = setup({ [`rpc:${fn}`]: { data: null, error: { message: 'gone', code } } });
      expect(await call(svc)).toEqual({ state: 'could_not_check' });
      expect(h.report).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ level: 'warning' }),
      );
    });
  }

  it.each(READS)('%s: any other failure is could_not_check, reported', async (_n, fn, call) => {
    const { svc } = setup({
      [`rpc:${fn}`]: { data: null, error: { message: 'boom', code: 'XX000' } },
    });
    expect(await call(svc)).toEqual({ state: 'could_not_check' });
    expect(h.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it.each(READS)('%s: a read that throws is could_not_check', async (_n, fn, call) => {
    const { svc } = setup({
      [`rpc:${fn}`]: () => {
        throw new Error('network');
      },
    });
    expect(await call(svc)).toEqual({ state: 'could_not_check' });
  });

  it('a register that is not a list is could_not_check, never empty', async () => {
    const { svc } = setup({ 'rpc:supplier_risk_register': { data: { rows: [] }, error: null } });
    expect(await svc.register()).toEqual({ state: 'could_not_check' });
  });

  it('a review that cannot be read as one is could_not_check', async () => {
    const { svc } = setup({ 'rpc:supplier_risk_review': { data: { id: REVIEW }, error: null } });
    expect(await svc.review(REVIEW)).toEqual({ state: 'could_not_check' });
  });

  it("another organization's review (the function answers null) is no review", async () => {
    const { svc } = setup({ 'rpc:supplier_risk_review': { data: null, error: null } });
    expect(await svc.review(REVIEW)).toEqual({ state: 'ok', value: null });
  });

  it('the owners and admins that could not be listed are could_not_check', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': { data: null, error: { message: 'x', code: '57014' } },
    });
    const svc = new SupplierRiskService(
      makeServiceContext(stub.client, { organizationId: ORG }) as never,
    );
    expect(await svc.ownersAndAdmins()).toEqual({ state: 'could_not_check' });
  });

  for (const code of ['PGRST202', '42883']) {
    it(`a write to a missing function (${code}) says nothing was saved`, async () => {
      const { svc } = setup({
        'rpc:supplier_risk_draft_discard': { data: null, error: { message: 'gone', code } },
      });
      const e = await refusal(svc.discardDraft(SUPPLIER));
      expect(e.code).toBe('conflict');
      expect(e.message).toBe(SUPPLIER_RISK_NOTHING_SAVED);
      expect(e.details?.reason).toBe('could_not_check');
    });
  }

  it('finish: a history that could not be read sends nothing', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_history': { data: null, error: { message: 'gone', code: 'PGRST202' } },
    });
    const e = await refusal(svc.finish(finishInput()));
    expect(e.message).toBe(SUPPLIER_RISK_NOTHING_SAVED);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['supplier_risk_history']);
  });
});

describe("the database's refusals, by the hint alone", () => {
  it.each(Object.keys(VENDOR_RISK_REFUSAL_WORDS))("22023 %s answers core's words", (word) => {
    const e = supplierRiskRefusalOf({ code: '22023', hint: word, message: 'ignored' });
    expect(e?.code).toBe('validation_error');
    expect(e?.message).toBe(
      VENDOR_RISK_REFUSAL_WORDS[word as keyof typeof VENDOR_RISK_REFUSAL_WORDS],
    );
    expect(e?.details?.refusal).toBe(word);
  });

  it('42501 hints: not allowed, the authenticator step, and the act-as seat', () => {
    expect(
      supplierRiskRefusalOf({ code: '42501', hint: 'supplier_risk_not_allowed' })?.message,
    ).toBe(SUPPLIER_RISK_FORBIDDEN);
    expect(supplierRiskRefusalOf({ code: '42501', hint: 'mfa_required' })?.details?.reason).toBe(
      'mfa_required',
    );
    expect(supplierRiskRefusalOf({ code: '42501', hint: 'aal2_required' })?.details?.reason).toBe(
      'aal2_required',
    );
    const seat = supplierRiskRefusalOf({ code: '42501', hint: VENDOR_RISK_ACT_AS_REFUSAL });
    expect(seat?.message).toBe(VENDOR_RISK_ACT_AS_REFUSAL_WORDS);
    expect(seat?.details?.reason).toBe(VENDOR_RISK_ACT_AS_REFUSAL);
  });

  it('55P03 (the supplier lock) is busy, to retry', () => {
    const e = supplierRiskRefusalOf({ code: '55P03' });
    expect(e?.code).toBe('conflict');
    expect(e?.message).toBe(SUPPLIER_RISK_BUSY);
    expect(e?.details?.retryable).toBe(true);
  });

  it("the error's own text is never read: a word in the message alone is not a refusal", () => {
    expect(supplierRiskRefusalOf({ code: '22023', message: 'bad_item' })).toBeNull();
    expect(supplierRiskRefusalOf({ code: '22023', hint: 'not_a_word_of_ours' })).toBeNull();
  });

  it('a refusal on a read is thrown, never could_not_check', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_register': {
        data: null,
        error: { message: 'x', code: '42501', hint: 'supplier_risk_not_allowed' },
      },
    });
    expect((await refusal(svc.register())).message).toBe(SUPPLIER_RISK_FORBIDDEN);
  });

  it('a write refused by the database answers its words; an unknown failure a fixed sentence', async () => {
    const refused = setup({
      'rpc:supplier_risk_draft_discard': {
        data: null,
        error: { message: 'x', code: '22023', hint: 'supplier_archived' },
      },
    });
    expect((await refusal(refused.svc.discardDraft(SUPPLIER))).message).toBe(
      VENDOR_RISK_REFUSAL_WORDS.supplier_archived,
    );
    const failed = setup({
      'rpc:supplier_risk_draft_discard': {
        data: null,
        error: { message: 'relation "secret_table" does not exist', code: 'XX000' },
      },
    });
    const e = await refusal(failed.svc.discardDraft(SUPPLIER));
    expect(e.code).toBe('internal_error');
    expect(e.message).not.toContain('secret_table');
  });
});

describe("core's checks before anything is sent", () => {
  it('a note with a hidden character is refused (answer_bad_note), nothing sent', async () => {
    const { stub, svc } = setup();
    const e = await refusal(
      svc.saveDraft({
        supplierId: SUPPLIER,
        dataLevel: 'staff',
        answers: { data_listed: { answer: 'yes', note: 'Seen\u200b in the contract' } },
      }),
    );
    expect(e.details?.refusal).toBe('answer_bad_note');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a security report date later than tomorrow in UTC is refused (answer_date_in_future)', async () => {
    const { stub, svc } = setup();
    const later = addVendorRiskDays(new Date().toISOString().slice(0, 10), 2);
    const e = await refusal(
      svc.saveDraft({
        supplierId: SUPPLIER,
        dataLevel: 'staff',
        answers: { security_report: { answer: 'yes', date: later } },
      }),
    );
    expect(e.details?.refusal).toBe('answer_date_in_future');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('finish: every question must be answered', async () => {
    const { stub, svc } = setup();
    const e = await refusal(
      svc.finish(finishInput({ answers: { data_listed: { answer: 'yes' } } })),
    );
    expect(e.details?.refusal).toBe('answers_incomplete');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('finish: a Yes to the security report needs its date', async () => {
    const { svc } = setup();
    const answers = { ...allNotShown(), security_report: { answer: 'yes' as const } };
    const e = await refusal(
      svc.finish(finishInput({ answers: answers as SupplierRiskFinishInput['answers'] })),
    );
    expect(e.details?.refusal).toBe('answer_date_missing');
  });

  it('finish: an override needs a reason of the reason rule; a reason needs a result', async () => {
    const { stub, svc } = setup();
    const short = await refusal(
      svc.finish(finishInput({ overrideResult: 'approve', overrideReason: 'too short' })),
    );
    expect(short.details?.refusal).toBe('bad_override_reason');
    const repeated = await refusal(
      svc.finish(
        finishInput({ overrideResult: 'approve', overrideReason: 'aaaa bbbb aaaa bbbb aaaa bbbb' }),
      ),
    );
    expect(repeated.details?.refusal).toBe('bad_override_reason');
    const orphan = await refusal(
      svc.finish(finishInput({ overrideResult: null, overrideReason: REASON })),
    );
    expect(orphan.details?.refusal).toBe('bad_override');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('finish: an item with a blank finding is refused', async () => {
    const { stub, svc } = setup();
    const e = await refusal(
      svc.finish(
        finishInput({
          items: [
            {
              questionKey: 'breach_notice',
              finding: '   ',
              action: 'Ask.',
              ownerUserId: null,
              dueOn: null,
            },
          ],
        }),
      ),
    );
    expect(e.details?.refusal).toBe('bad_item_text');
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('finish: the draft must be the one the page read', () => {
  it('a draft saved again since is refused (draft_moved), nothing finished', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_history': historyWithDraft('2026-11-27T10:05:00+00:00'),
    });
    const e = await refusal(svc.finish(finishInput()));
    expect(e.message).toBe(SUPPLIER_RISK_DRAFT_MOVED);
    expect(e.details?.reason).toBe('draft_moved');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['supplier_risk_history']);
  });

  it('a draft discarded elsewhere is refused too', async () => {
    const { svc } = setup({ 'rpc:supplier_risk_history': { data: [], error: null } });
    expect((await refusal(svc.finish(finishInput()))).details?.reason).toBe('draft_moved');
  });

  it('a draft opened elsewhere since the page read none is refused', async () => {
    const { svc } = setup({ 'rpc:supplier_risk_history': historyWithDraft() });
    expect((await refusal(svc.finish(finishInput({ draftUpdatedAt: null })))).details?.reason).toBe(
      'draft_moved',
    );
  });

  it('the same instant written another way finishes', async () => {
    expect(sameInstant('2026-11-27T10:00:00.123456+00:00', '2026-11-27T10:00:00.123456Z')).toBe(
      true,
    );
    expect(
      sameInstant('2026-11-27T10:00:00.123456+00:00', '2026-11-27T10:00:00.123457+00:00'),
    ).toBe(false);
    const { stub, svc } = setup({
      'rpc:supplier_risk_history': historyWithDraft(),
      'rpc:supplier_risk_finalise': finaliseAnswer(),
    });
    const done = await svc.finish(finishInput({ draftUpdatedAt: '2026-11-27T10:00:00.123456Z' }));
    expect(done).toMatchObject({
      reviewId: DRAFT,
      version: 2,
      result: 'do_not_use',
      overridden: false,
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([
      'supplier_risk_history',
      'supplier_risk_finalise',
    ]);
  });
});

describe('the shared audit log: nothing is written to it', () => {
  // audit_logs goes to every holder of activity_logs:read (a manager by
  // default), and these reviews are for owners and admins only: no write
  // logs a row (supplier-risk.audit-log.test.ts runs the real writer).
  it('a draft saved, a review finished with a result set, an item changed, a risk accepted, a draft discarded: no audit call', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_draft_save': {
        data: { review_id: DRAFT, version: 2, updated_at: DRAFT_AT },
        error: null,
      },
      'rpc:supplier_risk_history': historyWithDraft(),
      'rpc:supplier_risk_finalise': finaliseAnswer({
        override_result: 'approve',
        result: 'approve',
      }),
      'rpc:supplier_risk_review': reviewWithItem(),
      'rpc:supplier_risk_item_update': itemAnswer(),
      'rpc:supplier_risk_draft_discard': { data: true, error: null },
    });
    await svc.saveDraft({
      supplierId: SUPPLIER,
      dataLevel: 'staff',
      answers: { data_listed: { answer: 'yes', note: 'Private note about Example Supply Co' } },
    });
    const finished = await svc.finish(
      finishInput({ overrideResult: 'approve', overrideReason: REASON }),
    );
    expect(finished).toMatchObject({ result: 'approve', overridden: true });
    await svc.updateItem({
      reviewId: REVIEW,
      itemId: ITEM,
      status: 'accepted',
      ownerUserId: OTHER_ADMIN,
      dueOn: '2027-01-31',
      action: null,
      reason: REASON,
    });
    expect(await svc.discardDraft(SUPPLIER)).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('an item: read in this organization first, then changed', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    reviewId: REVIEW,
    itemId: ITEM,
    status: 'in_progress' as const,
    ownerUserId: null,
    dueOn: null,
    action: null,
    reason: null,
    ...over,
  });

  it("an item not on the review (another organization's, or made up) is not found, nothing sent", async () => {
    const { stub, svc } = setup({ 'rpc:supplier_risk_review': { data: null, error: null } });
    expect((await refusal(svc.updateItem(change()))).details?.refusal).toBe('item_not_found');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['supplier_risk_review']);
  });

  it('an item of an earlier version is refused (item_not_current)', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_review': reviewWithItem({ is_current: false }),
    });
    expect((await refusal(svc.updateItem(change()))).details?.refusal).toBe('item_not_current');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['supplier_risk_review']);
  });

  it('Risk accepted needs a reason; a reason is only for Risk accepted', async () => {
    const { stub, svc } = setup({ 'rpc:supplier_risk_review': reviewWithItem() });
    expect((await refusal(svc.updateItem(change({ status: 'accepted' })))).details?.refusal).toBe(
      'bad_item_reason',
    );
    expect((await refusal(svc.updateItem(change({ reason: REASON })))).details?.refusal).toBe(
      'bad_item_reason',
    );
    expect(stub.rpcCalls.every((c) => c.name !== 'supplier_risk_item_update')).toBe(true);
  });

  it('a reason with a hidden character is refused here (the page cleans it first)', async () => {
    const { stub, svc } = setup({ 'rpc:supplier_risk_review': reviewWithItem() });
    const e = await refusal(
      svc.updateItem(change({ status: 'accepted', reason: `${REASON}\u200d` })),
    );
    expect(e.details?.refusal).toBe('bad_item_reason');
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('the owners and admins an item may be given to', () => {
  it('owners and admins only, accepted, not a support seat, not disabled', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: [
          {
            user_id: ME,
            role: 'owner',
            user: { full_name: 'Avery Example', email: 'a@example.test' },
          },
          { user_id: OTHER_ADMIN, role: 'admin', user: { full_name: '', email: 'b@example.test' } },
          {
            user_id: '33333333-3333-4333-8333-333333333333',
            role: 'manager',
            user: { full_name: 'Casey Example' },
          },
          {
            user_id: '44444444-4444-4444-8444-444444444444',
            role: 'admin',
            user: { full_name: 'Drew Example', disabled_at: '2026-11-01T00:00:00Z' },
          },
        ],
        error: null,
      },
    });
    const svc = new SupplierRiskService(
      makeServiceContext(stub.client, { organizationId: ORG }) as never,
    );
    expect(await svc.ownersAndAdmins()).toEqual({
      state: 'ok',
      value: [
        { userId: ME, name: 'Avery Example' },
        { userId: OTHER_ADMIN, name: 'b@example.test' },
      ],
    });
    const chain = stub.chains.get('organization_members.select') ?? [];
    expect(chain).toEqual(expect.arrayContaining(['eq', 'not', 'is']));
    expect(stub.chainArgs.get('organization_members.select')).toContainEqual([
      'impersonation_expires_at',
      null,
    ]);
  });
});

describe("the history: the database's own record of a supplier's reviews, newest first", () => {
  // A row as 0481's draft of supplier_risk_events returns it (QUESTIONS.md 14).
  const OWNER_A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const OWNER_B = '0b0b0b0b-0000-4000-8000-00000000000b';
  const EVENT = (n: number, over: Record<string, unknown> = {}) => ({
    event_id: `ee000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    review_id: REVIEW,
    item_id: ITEM,
    question_key: 'breach_notice',
    event: 'risk_accepted',
    actor_user_id: OTHER_ADMIN,
    actor_name: 'Avery Example',
    actor_account_deleted: false,
    happened_at: `2026-11-27T10:${String(59 - (n % 60)).padStart(2, '0')}:00.123456+00:00`,
    detail: {
      status_before: 'open',
      status_after: 'accepted',
      owner_before_id: OWNER_A,
      owner_before_name: 'Avery Example',
      owner_after_id: OWNER_B,
      owner_after_name: 'Blake Example',
      due_on_before: '2026-12-31',
      due_on_after: null,
      reason: 'Accepted until January.',
    },
    ...over,
  });

  it('one page, read with the context organization and the supplier; no cursor: from the newest', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_events': { data: [EVENT(1), EVENT(2)], error: null },
    });
    const read = await svc.listEvents(SUPPLIER, null);
    expect(stub.rpcCalls).toEqual([
      {
        name: 'supplier_risk_events',
        args: {
          p_organization_id: ORG,
          p_supplier_id: SUPPLIER,
          p_before_at: null,
          p_before_id: null,
          p_limit: SUPPLIER_RISK_EVENTS_PAGE + 1,
        },
      },
    ]);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.value.next).toBeNull();
    // No account id is carried to the page: the owners and the actor by name only.
    expect(read.value.events[0]).toEqual({
      id: EVENT(1).event_id,
      event: 'risk_accepted',
      reviewId: REVIEW,
      itemId: ITEM,
      questionKey: 'breach_notice',
      actorName: 'Avery Example',
      actorAccountDeleted: false,
      at: EVENT(1).happened_at,
      detail: {
        version: null,
        result: null,
        computedResult: null,
        reason: 'Accepted until January.',
        before: {
          status: 'open',
          ownerName: 'Avery Example',
          ownerDeleted: false,
          dueOn: '2026-12-31',
        },
        after: {
          status: 'accepted',
          ownerName: 'Blake Example',
          ownerDeleted: false,
          dueOn: null,
        },
      },
    });
    expect(JSON.stringify(read.value)).not.toContain(OWNER_A);
    expect(JSON.stringify(read.value)).not.toContain(OTHER_ADMIN);
  });

  it('each kind reads its own detail keys: a finished review, a result set by an admin, a discarded draft', async () => {
    const finish = { event_id: EVENT(1).event_id, review_id: REVIEW, item_id: null, question_key: null };
    const { svc } = setup({
      'rpc:supplier_risk_events': {
        data: [
          EVENT(1, {
            ...finish,
            event: 'review_finished',
            detail: { version: 4, result: 'approve', rules_version: 1 },
          }),
          EVENT(2, {
            ...finish,
            event_id: EVENT(2).event_id,
            event: 'result_overridden',
            detail: {
              version: 3,
              rules_version: 1,
              computed_result: 'do_not_use',
              chosen_result: 'more_information',
              reason: 'The vendor showed us a signed letter.',
            },
          }),
          EVENT(3, {
            ...finish,
            event_id: EVENT(3).event_id,
            event: 'draft_discarded',
            actor_user_id: null,
            actor_account_deleted: true,
            detail: {},
          }),
        ],
        error: null,
      },
    });
    const read = await svc.listEvents(SUPPLIER, null);
    if (read.state !== 'ok') throw new Error('expected ok');
    const [finished, overridden, discarded] = read.value.events;
    expect(finished?.detail).toEqual({
      version: 4,
      result: 'approve',
      computedResult: null,
      reason: null,
      before: null,
      after: null,
    });
    expect(overridden?.detail).toEqual({
      version: 3,
      result: 'more_information',
      computedResult: 'do_not_use',
      reason: 'The vendor showed us a signed letter.',
      before: null,
      after: null,
    });
    expect(discarded).toMatchObject({
      event: 'draft_discarded',
      itemId: null,
      questionKey: null,
      actorAccountDeleted: true,
      detail: { version: null, result: null, reason: null, before: null, after: null },
    });
  });

  it('a full page gives the cursor of its last event, and the cursor reads the page after it', async () => {
    const rows = Array.from({ length: SUPPLIER_RISK_EVENTS_PAGE + 1 }, (_, i) => EVENT(i + 1));
    const { stub, svc } = setup({ 'rpc:supplier_risk_events': { data: rows, error: null } });
    const first = await svc.listEvents(SUPPLIER, null);
    if (first.state !== 'ok') throw new Error('expected ok');
    expect(first.value.events).toHaveLength(SUPPLIER_RISK_EVENTS_PAGE);
    const last = rows[SUPPLIER_RISK_EVENTS_PAGE - 1]!;
    // The time exactly as the database gave it (microseconds kept), so no row is skipped or repeated.
    expect(first.value.next).toBe(`${last.happened_at}~${last.event_id}`);
    await svc.listEvents(SUPPLIER, first.value.next);
    expect(stub.rpcCalls[1]?.args).toMatchObject({
      p_before_at: last.happened_at,
      p_before_id: last.event_id,
    });
  });

  it('a cursor that is not one (made up, or tampered with) reads from the newest', async () => {
    const { stub, svc } = setup({ 'rpc:supplier_risk_events': { data: [], error: null } });
    for (const bad of ['x', 'not-a-date~' + ITEM, '2026-11-27T10:00:00Z~not-a-uuid', '~']) {
      await svc.listEvents(SUPPLIER, bad);
    }
    for (const c of stub.rpcCalls) {
      expect(c.args).toMatchObject({ p_before_at: null, p_before_id: null });
    }
  });

  it('a supplier id that is not a uuid reads nothing', async () => {
    const { stub, svc } = setup();
    expect(await svc.listEvents('nope', null)).toEqual({
      state: 'ok',
      value: { events: [], next: null },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an event the page does not know keeps its own word; a detail value that is not text is dropped', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_events': {
        data: [
          EVENT(1, {
            event: 'something_new',
            question_key: 7,
            actor_account_deleted: 'yes',
            detail: { reason: { html: '<b>x</b>' }, version: 'four', result: 'great' },
          }),
          EVENT(2, {
            event_id: EVENT(2).event_id,
            detail: { status_before: 9, owner_before_name: ['x'], due_on_before: 'soon' },
          }),
          { event: 'item_changed' },
        ],
        error: null,
      },
    });
    const read = await svc.listEvents(SUPPLIER, null);
    if (read.state !== 'ok') throw new Error('expected ok');
    // The row with no id or time is not an event: it is left out, not guessed.
    expect(read.value.events).toHaveLength(2);
    expect(read.value.events[0]?.event).toBe('something_new');
    expect(read.value.events[0]?.questionKey).toBeNull();
    expect(read.value.events[0]?.actorAccountDeleted).toBe(false);
    expect(read.value.events[0]?.detail).toEqual({
      version: null,
      result: null,
      computedResult: null,
      reason: null,
      before: null,
      after: null,
    });
    expect(read.value.events[1]?.detail.before).toEqual({
      status: null,
      ownerName: null,
      ownerDeleted: false,
      dueOn: null,
    });
    expect(read.value.events[1]?.detail.after).toBeNull();
  });

  it('an owner kept by name with no account link is a deleted account; ids are never read', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_events': {
        data: [
          EVENT(1, {
            event: 'item_changed',
            detail: {
              status_before: 'open',
              status_after: 'open',
              owner_before_id: null,
              owner_before_name: 'Casey Example',
              owner_after_id: OWNER_B,
              owner_after_name: 'Blake Example',
              due_on_before: null,
              due_on_after: null,
            },
          }),
        ],
        error: null,
      },
    });
    const read = await svc.listEvents(SUPPLIER, null);
    if (read.state !== 'ok') throw new Error('expected ok');
    const d = read.value.events[0]!.detail;
    expect(d.before).toEqual({
      status: 'open',
      ownerName: 'Casey Example',
      ownerDeleted: true,
      dueOn: null,
    });
    expect(d.after?.ownerDeleted).toBe(false);
    expect(JSON.stringify(read.value)).not.toContain(OWNER_B);
  });

  it('a refusal of the database is thrown, never read as no history', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_events': {
        data: null,
        error: { message: 'x', code: '42501', hint: 'supplier_risk_not_allowed' },
      },
    });
    expect((await refusal(svc.listEvents(SUPPLIER, null))).message).toBe(SUPPLIER_RISK_FORBIDDEN);
  });

  it('an answer that is not a list is could_not_check', async () => {
    const { svc } = setup({ 'rpc:supplier_risk_events': { data: { rows: [] }, error: null } });
    expect(await svc.listEvents(SUPPLIER, null)).toEqual({ state: 'could_not_check' });
  });
});

describe('the register past the API row cap: every page is read, never cut silently (S7)', () => {
  /** n register rows; supplier ids in order, as the database's uuids compare. */
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      supplier_id: `5a5a5a5a-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      supplier_name: `Example Supply Co ${i + 1}`,
      supplier_state: 'active',
      review_due: 'not_reviewed',
    }));

  it('2,500 suppliers: three pages by supplier id, every row, complete', async () => {
    const all = rows(2500);
    const { stub, svc } = setup({ 'rpc:supplier_risk_register': servedLikePostgrest(all) });
    const read = await svc.register();
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.complete).toBe(true);
    expect(read.value).toHaveLength(2500);
    expect(new Set(read.value.map((r) => r.supplierId)).size).toBe(2500);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([
      'supplier_risk_register',
      'supplier_risk_register',
      'supplier_risk_register',
    ]);
    for (const c of stub.rpcCalls) expect(c.args).toEqual({ p_organization_id: ORG });
  });

  it('exactly one full page: the next page is read and found empty', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_register': servedLikePostgrest(rows(SUPPLIER_RISK_REGISTER_PAGE_ROWS)),
    });
    const read = await svc.register();
    expect(read.state === 'ok' && read.value.length).toBe(SUPPLIER_RISK_REGISTER_PAGE_ROWS);
    expect(read.state === 'ok' && read.complete).toBe(true);
    expect(stub.rpcCalls).toHaveLength(2);
  });

  it('more than the pages it reads: the rows read, said to be incomplete', async () => {
    const most = SUPPLIER_RISK_REGISTER_MAX_PAGES * SUPPLIER_RISK_REGISTER_PAGE_ROWS;
    const { stub, svc } = setup({ 'rpc:supplier_risk_register': servedLikePostgrest(rows(most + 1)) });
    const read = await svc.register();
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.complete).toBe(false);
    expect(read.value).toHaveLength(most);
    expect(stub.rpcCalls).toHaveLength(SUPPLIER_RISK_REGISTER_MAX_PAGES);
  });

  it('a later page that fails is could_not_check: never the first pages shown as the whole', async () => {
    const all = rows(1500);
    const served = servedLikePostgrest(all);
    const { svc } = setup({
      'rpc:supplier_risk_register': (call: MockCall) =>
        call.methods.includes('gt')
          ? { data: null, error: { message: 'boom', code: '57014' } }
          : served(call),
    });
    expect(await svc.register()).toEqual({ state: 'could_not_check' });
  });
});

describe('the newest version, for a finish another admin got to first (S2)', () => {
  const draftReview = {
    id: DRAFT,
    supplier_id: SUPPLIER,
    supplier_name: 'Example Supply Co',
    version: 2,
    status: 'draft',
    is_current: false,
    data_level: 'staff',
    answers: { data_listed: { answer: 'no', note: 'Their note.' } },
    updated_at: '2026-11-27T11:00:00+00:00',
    items: [],
  };
  const currentReview = {
    id: REVIEW,
    supplier_id: SUPPLIER,
    supplier_name: 'Example Supply Co',
    version: 1,
    status: 'final',
    is_current: true,
    data_level: 'staff',
    answers: { data_listed: { answer: 'yes' } },
    result: 'approve',
    computed_result: 'approve',
    reviewer_name: 'Blake Example',
    reviewed_at: '2026-11-20T10:00:00+00:00',
    items: [],
  };
  const reviews = (call: MockCall): QueryResult => {
    const id = (call.args[0]?.[0] as { p_review_id: string }).p_review_id;
    return { data: id === DRAFT ? draftReview : currentReview, error: null };
  };

  it('the open draft (when it was saved, its answers) and the current review, read in this organization', async () => {
    const { stub, svc } = setup({
      'rpc:supplier_risk_history': historyWithDraft('2026-11-27T11:00:00+00:00'),
      'rpc:supplier_risk_review': reviews,
    });
    expect(await svc.latest(SUPPLIER)).toEqual({
      state: 'ok',
      value: {
        draft: {
          reviewId: DRAFT,
          version: 2,
          updatedAt: '2026-11-27T11:00:00+00:00',
          dataLevel: 'staff',
          answers: { data_listed: { answer: 'no', note: 'Their note.' } },
        },
        current: {
          reviewId: REVIEW,
          version: 1,
          reviewedAt: '2026-11-20T10:00:00+00:00',
          reviewerName: 'Blake Example',
          dataLevel: 'staff',
          answers: { data_listed: { answer: 'yes' } },
          result: 'approve',
          overridden: false,
        },
      },
    });
    for (const c of stub.rpcCalls) expect((c.args as { p_organization_id: string }).p_organization_id).toBe(ORG);
  });

  it('no draft any more (discarded or finished elsewhere): only the current review', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_history': {
        data: [{ review_id: REVIEW, version: 1, status: 'final', is_current: true }],
        error: null,
      },
      'rpc:supplier_risk_review': reviews,
    });
    const read = await svc.latest(SUPPLIER);
    expect(read.state === 'ok' && read.value.draft).toBeNull();
    expect(read.state === 'ok' && read.value.current?.version).toBe(1);
  });

  it('a version that could not be read is could_not_check, never "no other version"', async () => {
    const { svc } = setup({
      'rpc:supplier_risk_history': historyWithDraft(),
      'rpc:supplier_risk_review': { data: null, error: { message: 'x', code: '57014' } },
    });
    expect(await svc.latest(SUPPLIER)).toEqual({ state: 'could_not_check' });
  });

  it('a support seat may read it (a read); nothing is written', async () => {
    const { stub, svc } = setup(
      {
        'rpc:supplier_risk_history': historyWithDraft(),
        'rpc:supplier_risk_review': reviews,
      },
      {},
      memberRows('2026-11-27T12:00:00Z'),
    );
    expect((await svc.latest(SUPPLIER)).state).toBe('ok');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([
      'supplier_risk_history',
      'supplier_risk_review',
      'supplier_risk_review',
    ]);
  });
});
