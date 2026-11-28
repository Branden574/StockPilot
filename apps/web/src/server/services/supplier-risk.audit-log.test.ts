// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vendorRiskQuestionsFor, type VendorRiskAnswers } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Security invariant: a vendor review leaves nothing in the shared audit log.
 *
 * audit_logs has ONE row policy, and it has no rule by event: every row of the
 * organization goes to every holder of activity_logs:read
 * (rls_orgs_with_permission, migration 0279), which a manager holds by default
 * and any role can be granted (the Auditor preset). The vendor reviews are for
 * owners and admins only. So none of the four writes of the vendor risk service
 * writes an audit row: a manager who reads the organization's audit log after
 * an admin saved a draft, finished a review with a result of their own, changed
 * an item, accepted a risk and discarded a draft finds nothing that says a
 * review exists. The record is the review tables themselves (each version keeps
 * who reviewed it and when; an override keeps its reason; each item keeps who
 * last changed it and when), read through 0481's admin-only functions.
 *
 * This file runs the real audit writer, so a call to audit() added back to the
 * service writes a row here and fails it. One row of another event is written
 * on purpose (a supplier archived) to show the harness does catch rows.
 */

const h = vi.hoisted(() => ({
  written: [] as Array<Record<string, unknown>>,
  ctx: null as unknown,
}));

vi.mock('next/server', () => ({ after: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
}));
// The admin client the audit writer uses: every row it sends is kept.
vi.mock('@/lib/supabase/admin', () => {
  const answered = (rows: unknown) => {
    const b = {
      abortSignal() {
        return b;
      },
      then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
        for (const r of [rows].flat()) h.written.push(r as Record<string, unknown>);
        return Promise.resolve({ data: null, error: null, status: 201 }).then(onOk, onErr);
      },
    };
    return b;
  };
  return {
    createAdminClient: () => ({
      from: () => ({ insert: answered, upsert: answered }),
    }),
  };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => undefined),
}));
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, withContext: vi.fn(async () => h.ctx) };
});
// test/setup.ts stands a no-op in for the writer in every file; this one runs
// the real one (as audit.test.ts does).
vi.unmock('@/server/services/audit');

import { audit } from './audit';
import { AuditLogService } from './audit-log';
import { SupplierRiskService } from './supplier-risk';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const MANAGER = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '5a5a5a5a-0000-4000-8000-000000000001';
const REVIEW = 'e1e1e1e1-0000-4000-8000-000000000001';
const DRAFT = 'e1e1e1e1-0000-4000-8000-000000000002';
const ITEM = '17e17e17-0000-4000-8000-000000000001';
const DRAFT_AT = '2026-11-27T10:00:00.123456+00:00';
const REASON = 'The vendor showed us a signed letter from their auditor this week.';

function allNotShown(): VendorRiskAnswers {
  const out: VendorRiskAnswers = {};
  for (const q of vendorRiskQuestionsFor('staff')) out[q.key] = { answer: 'not_shown' };
  return out;
}

const review = (status: string): QueryResult => ({
  data: {
    id: REVIEW,
    supplier_id: SUPPLIER,
    supplier_name: 'Example Supply Co',
    version: 1,
    status: 'final',
    is_current: true,
    data_level: 'student',
    answers: {},
    items: [
      {
        id: ITEM,
        review_id: REVIEW,
        question_key: 'no_ai_training',
        answer: 'not_shown',
        severity: 'critical',
        finding: 'Not shown.',
        action: 'Ask.',
        owner_user_id: ADMIN,
        due_on: '2026-12-31',
        status,
      },
    ],
  },
  error: null,
});

function adminService() {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: [{ impersonation_expires_at: null }], error: null },
    'rpc:supplier_risk_draft_save': {
      data: { review_id: DRAFT, version: 2, updated_at: DRAFT_AT },
      error: null,
    },
    'rpc:supplier_risk_history': {
      data: [
        { review_id: DRAFT, version: 2, status: 'draft', is_current: false, updated_at: DRAFT_AT },
      ],
      error: null,
    },
    'rpc:supplier_risk_finalise': {
      data: {
        review_id: DRAFT,
        version: 2,
        superseded_review_id: REVIEW,
        computed_result: 'do_not_use',
        override_result: 'more_information',
        result: 'more_information',
        next_review_on: '2027-05-27',
        items: 0,
      },
      error: null,
    },
    'rpc:supplier_risk_draft_discard': { data: true, error: null },
    'rpc:supplier_risk_review': review('open'),
    'rpc:supplier_risk_item_update': {
      data: { ...(review('accepted').data as { items: unknown[] }).items[0] },
      error: null,
    },
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG,
    userId: ADMIN,
    role: 'admin',
  });
  return { svc: new SupplierRiskService(ctx as never), ctx };
}

/** Lets every write the audit writer started finish (its first try). */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  h.written = [];
});

describe("a manager's read of the audit log shows no vendor review", () => {
  it('after every write an admin can make, the log holds no row about a review', async () => {
    const { svc, ctx } = adminService();
    await svc.saveDraft({
      supplierId: SUPPLIER,
      dataLevel: 'staff',
      answers: { data_listed: { answer: 'yes', note: 'Seen in the contract.' } },
    });
    await svc.finish({
      supplierId: SUPPLIER,
      dataLevel: 'staff',
      answers: allNotShown() as never,
      nextReviewOn: null,
      overrideResult: 'more_information',
      overrideReason: REASON,
      items: [],
      draftUpdatedAt: DRAFT_AT,
    });
    await svc.updateItem({
      reviewId: REVIEW,
      itemId: ITEM,
      status: 'in_progress',
      ownerUserId: ADMIN,
      dueOn: '2027-01-31',
      action: 'Ask again.',
      reason: null,
    });
    await svc.updateItem({
      reviewId: REVIEW,
      itemId: ITEM,
      status: 'accepted',
      ownerUserId: ADMIN,
      dueOn: '2027-01-31',
      action: null,
      reason: REASON,
    });
    await svc.discardDraft(SUPPLIER);
    // The control: another event of the same supplier, through the same writer.
    void audit({ event: 'supplier.archived', entityType: 'supplier', entityId: SUPPLIER }, ctx);
    await settle();

    expect(h.written.map((r) => r.event)).toEqual(['supplier.archived']);

    // The manager reads the organization's log as the row policy serves it:
    // every row of the organization, whatever its event.
    const managerStub = makeSupabaseStub({
      'audit_logs.select': servedLikePostgrest(() =>
        h.written.map((r, i) => ({ ...r, created_at: `2026-11-27T10:00:0${i}Z` })),
      ),
    });
    h.ctx = makeServiceContext(managerStub.client, {
      organizationId: ORG,
      userId: MANAGER,
      role: 'manager',
    });
    const { rows } = await (await AuditLogService.forCurrentUser()).list();
    expect(rows.map((r) => r.event)).toEqual(['supplier.archived']);
    const seen = JSON.stringify(rows);
    for (const told of [REVIEW, DRAFT, ITEM, 'risk', 'review', 'no_ai_training', 'critical']) {
      expect(seen).not.toContain(told);
    }
  });

  it('the audit event list names no vendor risk event, and the service does not import the writer', () => {
    const here = __dirname;
    const events = readFileSync(join(here, 'audit.ts'), 'utf8');
    expect(events).not.toMatch(/'supplier\.risk_/);
    const service = readFileSync(join(here, 'supplier-risk.ts'), 'utf8');
    expect(service).not.toMatch(/from '\.\/audit'/);
    expect(service).not.toMatch(/\baudit\(/);
  });
});
