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
  SUPPLIER_RISK_BUSY,
  SUPPLIER_RISK_DRAFT_MOVED,
  SUPPLIER_RISK_FORBIDDEN,
  SUPPLIER_RISK_NOTHING_SAVED,
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
      expect(await svc.register()).toEqual({ state: 'ok', value: [] });
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
