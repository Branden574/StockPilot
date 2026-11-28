import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VENDOR_RISK_ACT_AS_REFUSAL_WORDS, vendorRiskQuestionsFor } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Security invariant: one supplier's vendor review (/dashboard/suppliers/[id]/risk).
 *   - Page not found for an id that is not a uuid, for anyone but an owner
 *     or admin (nothing read), and for a supplier that is not in this
 *     organization's register.
 *   - A read that could not be made says so; it is never "not reviewed",
 *     and nothing can be changed until it is read.
 *   - A support (act-as) seat reads everything and gets no write control:
 *     no Save, no Finish, no Discard, no Change; a seat that could not be
 *     read is read-only too.
 *   - The current review shows its result with every reason, an override
 *     "Set by <name>: reason" as written; the questions to send the vendor
 *     are plain text; earlier versions are read-only.
 *   - Names in a sentence sit in <bdi>.
 */

const h = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const R = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      R.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: async () => ({ enabled: true }),
}));
vi.mock('@/components/dashboard/module-unavailable', () => ({ ModuleUnavailable: () => null }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => ({ timezone: 'America/Los_Angeles' }),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: async () => h.ctx };
});
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/server/actions/supplier-risk', () => ({
  saveSupplierRiskDraftAction: vi.fn(),
  finishSupplierRiskReviewAction: vi.fn(),
  discardSupplierRiskDraftAction: vi.fn(),
  updateSupplierRiskItemAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import SupplierRiskReviewPage from './page';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ME = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '5a5a5a5a-0000-4000-8000-000000000001';
const CURRENT = 'e1e1e1e1-0000-4000-8000-000000000003';
const EARLIER = 'e1e1e1e1-0000-4000-8000-000000000002';
const DRAFT = 'e1e1e1e1-0000-4000-8000-000000000004';
const REASON = 'The vendor showed us a signed letter.\nWe follow up in January.';

function allAnswered(answer: 'yes' | 'no' | 'not_shown' = 'no') {
  return Object.fromEntries(vendorRiskQuestionsFor('staff').map((q) => [q.key, { answer }]));
}

const registerRow = (over: Record<string, unknown> = {}) => ({
  supplier_id: SUPPLIER,
  supplier_name: 'Example Supply Co',
  reviewed_as_name: 'Example Supplies',
  name_changed: true,
  supplier_state: 'active',
  review_id: CURRENT,
  version: 3,
  result: 'more_information',
  review_due: 'scheduled',
  ...over,
});

const reviewRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier_id: SUPPLIER,
  supplier_name: 'Example Supplies',
  version: id === CURRENT ? 3 : id === DRAFT ? 4 : 2,
  status: id === DRAFT ? 'draft' : 'final',
  is_current: id === CURRENT,
  rules_version: 1,
  data_level: 'staff',
  answers: allAnswered(),
  starting_risk: 'moderate',
  evidence: 'weak',
  residual_risk: 'high',
  hard_stops: [],
  computed_result: 'do_not_use',
  override_result: id === CURRENT ? 'more_information' : null,
  override_reason: id === CURRENT ? REASON : null,
  result: id === CURRENT ? 'more_information' : 'do_not_use',
  reviewer_name: 'Rami Example',
  reviewed_at: '2026-11-27T10:00:00Z',
  reviewed_on: '2026-11-27',
  next_review_on: '2027-11-27',
  items:
    id === CURRENT
      ? [
          {
            id: '17e17e17-0000-4000-8000-000000000001',
            review_id: CURRENT,
            question_key: 'breach_notice',
            answer: 'no',
            severity: 'high',
            finding: 'No breach notice clause.',
            action: 'Ask for one.',
            owner_user_id: ME,
            owner_name: 'Avery Example',
            owner_is_admin: true,
            status: 'open',
          },
        ]
      : [],
  ...over,
});

interface Setup {
  register?: QueryResult;
  history?: QueryResult;
  review?: (id: string) => QueryResult;
  seat?: QueryResult;
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
}

function useStub(s: Setup = {}) {
  const stub = makeSupabaseStub({
    'rpc:supplier_risk_register': s.register ?? { data: [registerRow()], error: null },
    'rpc:supplier_risk_history': s.history ?? {
      data: [
        {
          review_id: CURRENT,
          version: 3,
          status: 'final',
          is_current: true,
          result: 'more_information',
          overridden: true,
          reviewer_name: 'Rami Example',
          reviewed_at: '2026-11-27T10:00:00Z',
        },
        {
          review_id: EARLIER,
          version: 2,
          status: 'final',
          is_current: false,
          result: 'do_not_use',
          reviewer_name: 'Rami Example',
          reviewed_at: '2026-05-01T10:00:00Z',
        },
      ],
      error: null,
    },
    'rpc:supplier_risk_review': (call: MockCall) => {
      const id = (call.args[0]?.[0] as { p_review_id: string }).p_review_id;
      return s.review ? s.review(id) : { data: reviewRow(id), error: null };
    },
    'organization_members.select': (call: MockCall) => {
      const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
      if (select.includes('user_id')) {
        return {
          data: [{ user_id: ME, role: 'owner', user: { full_name: 'Avery Example' } }],
          error: null,
        };
      }
      return s.seat ?? { data: [{ impersonation_expires_at: null }], error: null };
    },
  });
  h.ctx = makeServiceContext(stub.client, {
    organizationId: ORG,
    userId: ME,
    role: s.role ?? 'admin',
  });
  return stub;
}

const params = (id = SUPPLIER, version?: string) => ({
  params: Promise.resolve({ id }),
  searchParams: Promise.resolve(version ? { version } : {}),
});

async function thrown(p = params()): Promise<string> {
  try {
    await SupplierRiskReviewPage(p);
  } catch (e) {
    return (e as Error).message;
  }
  return 'rendered';
}

const page = async (p = params()) => render(await SupplierRiskReviewPage(p));

beforeEach(() => {
  h.ctx = null;
});

describe('Page not found, before anything is read', () => {
  it('an id that is not a uuid', async () => {
    const stub = useStub();
    expect(await thrown(params('not-a-uuid'))).toBe('NOT_FOUND');
    expect(stub.rpcCalls).toEqual([]);
  });

  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it(`a ${role}`, async () => {
      const stub = useStub({ role });
      expect(await thrown()).toBe('NOT_FOUND');
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    });
  }

  it("a supplier that is not in this organization's register (another organization's)", async () => {
    const stub = useStub({
      register: {
        data: [registerRow({ supplier_id: '5a5a5a5a-0000-4000-8000-000000000009' })],
        error: null,
      },
    });
    expect(await thrown()).toBe('NOT_FOUND');
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('supplier_risk_review');
  });
});

describe('could not check is said, never "not reviewed"', () => {
  it('a register that could not be read', async () => {
    useStub({ register: { data: null, error: { message: 'gone', code: 'PGRST202' } } });
    await page();
    expect(
      screen.getByText('Vendor reviews could not be checked just now. Try again in a minute.'),
    ).toBeTruthy();
    expect(screen.queryByText('Not reviewed yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('a current review that could not be read: no write control', async () => {
    useStub({ review: () => ({ data: null, error: { message: 'x', code: '57014' } }) });
    await page();
    expect(screen.getByText(/Part of this review could not be read/)).toBeTruthy();
    expect(screen.queryByText('Not reviewed yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finish/ })).toBeNull();
  });
});

describe('an owner or admin on their own seat', () => {
  it('the result with its reasons, the override as written, the items, the questions to send, the form', async () => {
    useStub();
    const { container } = await page();
    const override = container.querySelector('[data-slot="supplier-risk-override"]');
    expect(override?.textContent).toMatch(/The rules gave: Do not use/);
    expect(override?.querySelector('bdi')?.textContent).toBe('Rami Example');
    expect(override?.querySelector('span')?.textContent).toBe(REASON);
    expect(screen.getByRole('button', { name: /Change the item/ })).toBeTruthy();
    const questions = screen.getByLabelText(/Paste these into an email/) as HTMLTextAreaElement;
    expect(questions.readOnly).toBe(true);
    expect(questions.value).toMatch(/Example Supply Co/);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish the review…' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read version 2' }).getAttribute('href')).toBe(
      `/dashboard/suppliers/${SUPPLIER}/risk?version=${EARLIER}`,
    );
  });

  it("the supplier's name and the name it was reviewed as sit in <bdi>", async () => {
    useStub();
    const { container } = await page();
    const header = container.querySelector('header') ?? container;
    const names = Array.from(header.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(names.slice(0, 2)).toEqual(['Example Supply Co', 'Example Supplies']);
  });

  it('an earlier version is read-only: no form, no Change', async () => {
    useStub();
    await page(params(SUPPLIER, EARLIER));
    expect(screen.getByText(/You are reading version 2, an earlier review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change the item/ })).toBeNull();
  });

  it('a version id that is not an earlier final of this supplier shows the current review', async () => {
    useStub();
    await page(params(SUPPLIER, DRAFT));
    expect(screen.queryByText(/You are reading version/)).toBeNull();
    expect(screen.getByText('Current review')).toBeTruthy();
  });

  it('an archived supplier: read-only answers, items still changeable, a draft discardable', async () => {
    useStub({
      register: { data: [registerRow({ supplier_state: 'archived' })], error: null },
      history: {
        data: [
          {
            review_id: DRAFT,
            version: 4,
            status: 'draft',
            is_current: false,
            updated_at: '2026-11-27T11:00:00Z',
          },
          { review_id: CURRENT, version: 3, status: 'final', is_current: true },
        ],
        error: null,
      },
    });
    await page();
    expect(screen.getByText(/This supplier is archived/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Change the item/ })).toBeTruthy();
  });
});

describe('a support (act-as) seat, and a seat that could not be read: no write control', () => {
  it('a support seat reads everything and is told why it cannot change anything', async () => {
    useStub({
      seat: { data: [{ impersonation_expires_at: '2026-11-27T12:00:00Z' }], error: null },
    });
    const { container } = await page();
    expect(container.querySelector('[data-slot="supplier-risk-read-only"]')?.textContent).toBe(
      VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
    );
    expect(screen.getByText('Current review')).toBeTruthy();
    expect(screen.getByText('Answers of the current review')).toBeTruthy();
    for (const name of ['Save draft', 'Finish the review…', 'Discard draft']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Change the item/ })).toBeNull();
  });

  it('a seat that could not be read is read-only too', async () => {
    useStub({ seat: { data: null, error: { message: 'x', code: '57014' } } });
    const { container } = await page();
    expect(container.querySelector('[data-slot="supplier-risk-read-only"]')?.textContent).toMatch(
      /We could not check whether this session may change vendor reviews/,
    );
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change the item/ })).toBeNull();
  });
});

describe('dates in the organization zone (S3)', () => {
  it('"Draft saved" is the moment in the organization zone, named, with the exact UTC beside it', async () => {
    useStub({
      history: {
        data: [
          {
            review_id: DRAFT,
            version: 4,
            status: 'draft',
            is_current: false,
            updated_at: '2026-11-28T01:30:00Z',
          },
          {
            review_id: CURRENT,
            version: 3,
            status: 'final',
            is_current: true,
            reviewed_at: '2026-11-28T01:00:00Z',
            reviewer_name: 'Rami Example',
          },
        ],
        error: null,
      },
    });
    const { container } = await page();
    const saved = screen.getByText(/^Draft saved/);
    expect(saved.textContent).toContain('Draft saved November 27, 2026, 5:30 PM PST');
    expect(saved.querySelector('time')?.getAttribute('title')).toBe('28 Nov 2026, 01:30 UTC');
    // The Versions table: the Pacific day of the finish, not the UTC one.
    const versions = container.querySelector('#supplier-risk-versions')?.closest('section');
    expect(versions?.textContent).toContain('November 27, 2026');
    expect(versions?.textContent).not.toContain('November 28, 2026');
  });
});
