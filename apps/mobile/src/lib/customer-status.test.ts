import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATOR_SET_UP_OWED_COPY,
  CONTEXT_UNAVAILABLE_COPY,
  contextUnavailableBody,
} from '@stockpilot/core';

import { screenFunction } from './__fixtures__/screen-functions';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  CUSTOMER_STATUS_COPY,
  CUSTOMER_STATUS_FAILED_TITLE,
  changeCustomerStatus,
  customerStatusFailure,
  customerStatusPath,
} from './customer-status';

/**
 * ARCHIVE AND RESTORE A CUSTOMER ACCOUNT ON THE PHONE (the Accounts screen).
 *
 * The switch sends PATCH /api/v1/customers/[id]/status with
 * `{ status: 'active' | 'archived' }` through api(), under the workspace whose
 * list is on screen. The route answers 200 `{ ok, status, changed }` or a
 * refusal in the change routes' shape `{ error, message, details? }`
 * (apps/web/src/app/api/v1/change-error-response.ts). Here: the request, each
 * answer's words and whether the list is read again, the screen's own
 * setStatus run against each outcome, and the screen's source (no table write
 * for the status).
 */

// ./api reaches for expo-constants, AsyncStorage and Supabase at import time.
const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  return { api: vi.fn(async (..._a: unknown[]) => ({}) as unknown), ApiError };
});
vi.mock('./api', () => apiMock);

const CUSTOMER = 'c0ffee00-0000-4000-8000-00000000c001';
const ORG = 'a0000000-0000-4000-8000-00000000000a';

const err = (status: number, message: string, code?: string, details?: unknown) =>
  new apiMock.ApiError(message, status, code, details);

beforeEach(() => apiMock.api.mockReset());

describe('the request', () => {
  it('is one PATCH to the route with the status, under the workspace on screen', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, status: 'archived', changed: true });
    await changeCustomerStatus(CUSTOMER, 'archived', ORG);
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/customers/${CUSTOMER}/status`, {
      method: 'PATCH',
      body: { status: 'archived' },
      orgId: ORG,
    });
  });

  it('sends active for a restore', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, status: 'active', changed: true });
    await changeCustomerStatus(CUSTOMER, 'active', ORG);
    expect(apiMock.api.mock.calls[0]![1]).toEqual({
      method: 'PATCH',
      body: { status: 'active' },
      orgId: ORG,
    });
  });

  it('puts the id in the path as one encoded segment', () => {
    expect(customerStatusPath(CUSTOMER)).toBe(`/api/v1/customers/${CUSTOMER}/status`);
    expect(customerStatusPath('a/b?c')).toBe('/api/v1/customers/a%2Fb%3Fc/status');
  });
});

describe('a 200', () => {
  it('is saved with the status the server answered', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, status: 'archived', changed: true });
    await expect(changeCustomerStatus(CUSTOMER, 'archived', ORG)).resolves.toEqual({
      kind: 'saved',
      status: 'archived',
      changed: true,
    });
  });

  it('with changed false is saved too, with the status the account has', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, status: 'active', changed: false });
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG)).resolves.toEqual({
      kind: 'saved',
      status: 'active',
      changed: false,
    });
  });

  it.each([
    ['no status', { ok: true, changed: true }],
    ['an unknown status', { ok: true, status: 'deleted', changed: true }],
    ['no changed flag', { ok: true, status: 'active' }],
    ['not an object', 'ok'],
    ['null', null],
  ])('with %s is not trusted: the list is read again', async (_label, body) => {
    apiMock.api.mockResolvedValueOnce(body);
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG)).resolves.toEqual({
      kind: 'refused',
      title: CUSTOMER_STATUS_FAILED_TITLE,
      message: CUSTOMER_STATUS_COPY.serverProblem,
      reload: true,
    });
  });
});

describe('each refusal: its words, and whether the list is read again', () => {
  const MARKER = contextUnavailableBody();

  it.each([
    [
      '401 (no message: api() puts the code word in message)',
      err(401, 'unauthenticated', 'unauthenticated'),
      CUSTOMER_STATUS_COPY.sessionEnded,
      false,
    ],
    [
      '403 mfa_required: core set-up sentence, never the server words',
      err(
        403,
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
        'forbidden',
        { reason: 'mfa_required' },
      ),
      AUTHENTICATOR_SET_UP_OWED_COPY,
      false,
    ],
    [
      '403 aal2_required',
      err(403, 'Re-authenticate with MFA before performing this action.', 'forbidden', {
        reason: 'aal2_required',
      }),
      CUSTOMER_STATUS_COPY.codeOwed,
      false,
    ],
    [
      '403 forbidden: never "Missing permission: ..."',
      err(403, 'Missing permission: customers:manage', 'forbidden'),
      CUSTOMER_STATUS_COPY.notAllowed,
      false,
    ],
    [
      '403 module_disabled: never the module id',
      err(403, 'Module not enabled for this organization: b2b_portal', 'module_disabled'),
      CUSTOMER_STATUS_COPY.moduleOff,
      false,
    ],
    [
      '404 not_found',
      err(404, 'Customer not found', 'not_found'),
      CUSTOMER_STATUS_COPY.notFound,
      true,
    ],
    [
      '404 with no body (a server without the route): api() words it',
      err(
        404,
        'That is not available on this version of the app. Update the app and try again.',
        undefined,
      ),
      'That is not available on this version of the app. Update the app and try again.',
      false,
    ],
    [
      '409 conflict: the server sentence',
      err(409, 'This account was just changed. Refresh and try again.', 'conflict'),
      'This account was just changed. Refresh and try again.',
      true,
    ],
    [
      '409 with only a code: a sentence, never the code',
      err(409, 'conflict', 'conflict'),
      CUSTOMER_STATUS_COPY.changedMeanwhile,
      true,
    ],
    [
      '429 from the route',
      err(429, 'Too many requests. Wait a moment and try again.', 'rate_limited'),
      CUSTOMER_STATUS_COPY.tooMany,
      false,
    ],
    [
      '429 from the edge (no JSON): the same try-again sentence',
      err(429, 'Request failed (429).', undefined),
      CUSTOMER_STATUS_COPY.tooMany,
      false,
    ],
    [
      '400 validation_error: the route sentence',
      err(400, 'Choose a status: active or archived.', 'validation_error'),
      'Choose a status: active or archived.',
      false,
    ],
    [
      '400 with only a code',
      err(400, 'validation_error', 'validation_error'),
      CUSTOMER_STATUS_COPY.notChanged,
      false,
    ],
    [
      '503 marked as refused before any write: core sentence, try again',
      err(503, MARKER.message, MARKER.error, MARKER.details),
      CONTEXT_UNAVAILABLE_COPY,
      false,
    ],
    [
      '503 with no mark (a gateway)',
      err(503, 'The server had a problem. Try again in a moment.', undefined),
      CUSTOMER_STATUS_COPY.serverProblem,
      true,
    ],
    [
      '500 internal_error',
      err(500, 'An internal error occurred. Please try again.', 'internal_error'),
      CUSTOMER_STATUS_COPY.serverProblem,
      true,
    ],
    [
      'the timeout: api() sentence',
      new Error(REQUEST_TIMED_OUT_COPY),
      REQUEST_TIMED_OUT_COPY,
      true,
    ],
    [
      'no connection: the app sentence, never the platform text',
      new TypeError(
        'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
      ),
      CONNECTION_FAILURE_COPY,
      false,
    ],
    [
      'a 200 with a body that is not JSON',
      new SyntaxError('JSON Parse error: Unexpected end of input'),
      CUSTOMER_STATUS_COPY.serverProblem,
      true,
    ],
    ['anything else thrown', 'boom', CONNECTION_FAILURE_COPY, false],
  ])('%s', async (_label, thrown, message, reload) => {
    expect(customerStatusFailure(thrown)).toEqual({
      title: CUSTOMER_STATUS_FAILED_TITLE,
      message,
      reload,
    });
    apiMock.api.mockRejectedValueOnce(thrown);
    await expect(changeCustomerStatus(CUSTOMER, 'archived', ORG)).resolves.toEqual({
      kind: 'refused',
      title: CUSTOMER_STATUS_FAILED_TITLE,
      message,
      reload,
    });
  });

  it('shows no code, id or module name in any sentence', () => {
    for (const [key, s] of Object.entries(CUSTOMER_STATUS_COPY)) {
      expect(s, key).not.toMatch(/[a-z]+_[a-z]+|customers:|b2b_portal|\(\d{3}\)/);
      expect(s, key).toMatch(/^[A-Z].*\.$/);
    }
    expect(CUSTOMER_STATUS_COPY.notAllowed).toBe('You need manager access to change accounts.');
  });

  it('a 403 refusal says authenticator, not MFA', () => {
    for (const s of [CUSTOMER_STATUS_COPY.codeOwed, AUTHENTICATOR_SET_UP_OWED_COPY]) {
      expect(s).toMatch(/authenticator/);
      expect(s).not.toMatch(/MFA|two-factor|multi-factor/i);
    }
  });
});

/* ───────────── the screen's own setStatus, run against each outcome ───────────── */

const SCREEN = 'app/(drawer)/customers.tsx';
const MOBILE_ROOT = path.resolve(__dirname, '../..');

type Row = { id: string; name: string; status: 'active' | 'archived' };
type List = { orgId: string; userId: string | null; rows: Row[] } | null;

function screen(outcome: unknown, start: List, activeOrgId: string | null = ORG) {
  const state: { list: List; busy: (string | null)[] } = { list: start, busy: [] };
  const change = vi.fn(async (..._a: unknown[]) => outcome);
  const alert = vi.fn();
  const load = vi.fn(async () => undefined);
  const setStatus = screenFunction<(row: Row, active: boolean) => Promise<void>>(
    SCREEN,
    'setStatus',
    {
      activeOrgId,
      userId: 'u1',
      changeCustomerStatus: change,
      Alert: { alert },
      load,
      setBusyId: (v: string | null) => state.busy.push(v),
      setList: (fn: (prev: List) => List) => {
        state.list = fn(state.list);
      },
      // A table write left in setStatus fails the test loudly.
      supabase: {
        from: () => {
          throw new Error('setStatus wrote the table');
        },
      },
    },
  );
  return { state, change, alert, load, setStatus };
}

const A: Row = { id: CUSTOMER, name: 'Northwind Test Co', status: 'active' };
const B: Row = {
  id: 'c0ffee00-0000-4000-8000-00000000c002',
  name: 'Contoso Test',
  status: 'active',
};
const LIST: List = { orgId: ORG, userId: 'u1', rows: [A, B] };

describe('the Accounts screen', () => {
  it('archives through the route under the workspace on screen, and shows the saved status', async () => {
    const s = screen({ kind: 'saved', status: 'archived', changed: true }, LIST);
    await s.setStatus(A, false);
    expect(s.change).toHaveBeenCalledWith(CUSTOMER, 'archived', ORG);
    expect(s.state.busy).toEqual([CUSTOMER, null]);
    expect(s.state.list?.rows).toEqual([{ ...A, status: 'archived' }, B]);
    expect(s.alert).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });

  it('restores with active', async () => {
    const archived = { ...A, status: 'archived' as const };
    const s = screen(
      { kind: 'saved', status: 'active', changed: true },
      { orgId: ORG, userId: 'u1', rows: [archived, B] },
    );
    await s.setStatus(archived, true);
    expect(s.change).toHaveBeenCalledWith(CUSTOMER, 'active', ORG);
    expect(s.state.list?.rows).toEqual([A, B]);
  });

  it('changed false: the row shows the status the server answered', async () => {
    // The list said active; the account was already archived on the server.
    const s = screen({ kind: 'saved', status: 'archived', changed: false }, LIST);
    await s.setStatus(A, false);
    expect(s.state.list?.rows).toEqual([{ ...A, status: 'archived' }, B]);
    expect(s.alert).not.toHaveBeenCalled();
  });

  it('a refusal: the alert, and the row keeps the status it had', async () => {
    const s = screen(
      {
        kind: 'refused',
        title: 'Could not update',
        message: 'You need manager access to change accounts.',
        reload: false,
      },
      LIST,
    );
    await s.setStatus(A, false);
    expect(s.alert).toHaveBeenCalledWith(
      'Could not update',
      'You need manager access to change accounts.',
    );
    expect(s.state.list).toEqual(LIST);
    expect(s.state.busy).toEqual([CUSTOMER, null]);
    expect(s.load).not.toHaveBeenCalled();
  });

  it('a refusal that leaves the account unknown: the list is read again', async () => {
    const s = screen(
      {
        kind: 'refused',
        title: 'Could not update',
        message: 'This account may have been removed.',
        reload: true,
      },
      LIST,
    );
    await s.setStatus(A, false);
    expect(s.alert).toHaveBeenCalledTimes(1);
    expect(s.state.list).toEqual(LIST);
    expect(s.load).toHaveBeenCalledTimes(1);
  });

  it('an answer for another workspace list never lands in this one', async () => {
    const other: List = { orgId: 'b0000000-0000-4000-8000-00000000000b', userId: 'u1', rows: [A] };
    const s = screen({ kind: 'saved', status: 'archived', changed: true }, other);
    await s.setStatus(A, false);
    expect(s.state.list).toEqual(other);
  });

  it('with no workspace known, nothing is sent', async () => {
    const s = screen({ kind: 'saved', status: 'archived', changed: true }, LIST, null);
    await s.setStatus(A, false);
    expect(s.change).not.toHaveBeenCalled();
    expect(s.state.busy).toEqual([]);
    expect(s.state.list).toEqual(LIST);
  });
});

describe('the Accounts screen source', () => {
  const src = readFileSync(path.join(MOBILE_ROOT, SCREEN), 'utf8');
  const sf = ts.createSourceFile(SCREEN, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  /** Every call `<x>.from('<table>')` in the file, with the methods chained on it. */
  function tableCalls(): { table: string; chain: string[] }[] {
    const out: { table: string; chain: string[] }[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'from' &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        const chain: string[] = [];
        let up: ts.Node = n;
        while (
          ts.isPropertyAccessExpression(up.parent) &&
          ts.isCallExpression(up.parent.parent) &&
          up.parent.parent.expression === up.parent
        ) {
          chain.push(up.parent.name.text);
          up = up.parent.parent;
        }
        out.push({ table: n.arguments[0].text, chain });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  it('reads the accounts list from the table and writes nothing to it', () => {
    const calls = tableCalls();
    expect(calls.map((c) => c.table)).toEqual(['customers']);
    expect(calls[0]!.chain[0]).toBe('select');
    for (const c of calls) {
      for (const write of ['insert', 'update', 'upsert', 'delete']) {
        expect(c.chain, `${c.table}.${write}`).not.toContain(write);
      }
    }
  });

  it('changes the status only through changeCustomerStatus', () => {
    expect(src).toContain("import { changeCustomerStatus } from '@/lib/customer-status';");
    let setStatus: ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'setStatus') setStatus = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const body = setStatus!.body!.getText(sf);
    expect(body).toContain('await changeCustomerStatus(');
    expect(body).not.toMatch(/supabase|\.update\(/);
  });
});
