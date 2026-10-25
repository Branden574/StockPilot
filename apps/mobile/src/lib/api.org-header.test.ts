import * as path from 'node:path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listTsx, parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { api, orgHeader } from './api';

/**
 * The workspace header names only the signed-in account's own saved workspace
 * (docket B10: the 401 burst about a second after a password sign-in).
 *
 * THE DEFECT. api() sent X-Organization-Id from the saved workspace whoever
 * saved it. The biometric and MFA fallbacks ("Use password instead", "Use a
 * different account") and a session the server ended keep that key for the
 * person coming back, so the next account to sign in sent the previous
 * account's organization on its first requests (/me/seen, /me/announcements,
 * /mobile/snapshot), and the server refused each one with a 401 (a requested
 * organization the caller is not a member of is a refusal, not a fallback:
 * apps/web/src/lib/auth/api-context.ts). Each 401 also asked the eviction bus
 * for a probe.
 *
 * THE REVIEW FINDING (automated security review of the first fix). The screens
 * that call fetch themselves (a PO scan, an AI count photo and its saves, a
 * chat question, a book list photo) called orgHeader() with no account, so it
 * read the stored session on its own and took an unreadable one as nobody: a
 * workspace this account saved was then not named, and the request landed in
 * its default organization while the screen showed another. Or, with another
 * account's session stored, it named that account's workspace beside this
 * session's token. orgHeader now takes the account, and every one of those
 * screens passes the account of the session whose token it sends.
 *
 * Executed against the real api.ts; vi.hoisted and vi.mock run before it loads.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

const state = vi.hoisted(() => ({
  saved: {} as Record<string, string>,
  session: { access_token: 'token-u2', user: { id: 'u2' } } as null | {
    access_token: string;
    user: { id: string };
  },
  stored: { present: true, userId: 'u2' as string | null },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async (key: string) => state.saved[key] ?? null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
const supabaseMock = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: state.session } })),
  readDeviceAuthSession: vi.fn(async () => state.stored),
}));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: supabaseMock.getSession } },
  readDeviceAuthSession: supabaseMock.readDeviceAuthSession,
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => '{}',
  json: async () => ({}),
}));

function sentHeaders(): Record<string, string> {
  const init = (
    fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
  )[1];
  return init.headers;
}

/** The saved workspace as use-workspace.ts writes it (owner absent: an older build's). */
function save(orgId: string, ownerId?: string) {
  state.saved = { 'workspace.activeOrgId': orgId };
  if (ownerId) state.saved['workspace.activeOrgUserId'] = ownerId;
}

beforeEach(() => {
  state.saved = {};
  state.session = { access_token: 'token-u2', user: { id: 'u2' } };
  state.stored = { present: true, userId: 'u2' };
  fetchMock.mockClear();
  supabaseMock.getSession.mockClear();
  supabaseMock.readDeviceAuthSession.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('api() names the saved workspace only for the account that saved it', () => {
  it("another account's saved workspace is not named: the server answers for this account's own", async () => {
    save('org-a', 'u1');
    await api('/api/v1/me/seen', { method: 'POST' });
    expect(sentHeaders()).not.toHaveProperty('X-Organization-Id');
    expect(sentHeaders().Authorization).toBe('Bearer token-u2');
  });

  it("this account's saved workspace is named", async () => {
    save('org-b', 'u2');
    await api('/api/v1/me/announcements');
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });

  it('a workspace saved by an older build (no owner) is named, as before', async () => {
    save('org-b');
    await api('/api/v1/mobile/snapshot');
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });

  it('the owner is checked against the account whose bearer is sent, from the same session read', async () => {
    save('org-b', 'u2');
    await api('/api/v1/me/seen', { method: 'POST' });
    expect(supabaseMock.getSession).toHaveBeenCalledTimes(1);
    expect(supabaseMock.readDeviceAuthSession).not.toHaveBeenCalled();
  });

  it('a request that names its own workspace still sends that one', async () => {
    save('org-a', 'u1');
    await api('/api/v1/cycle-counts/c1/lines', { method: 'POST', orgId: 'org-c' });
    expect(sentHeaders()['X-Organization-Id']).toBe('org-c');
  });

  it('with nobody signed in, an owned workspace is not named', async () => {
    save('org-a', 'u1');
    state.session = null;
    await api('/api/v1/public/thing');
    expect(sentHeaders()).not.toHaveProperty('X-Organization-Id');
    expect(sentHeaders()).not.toHaveProperty('Authorization');
  });
});

describe('orgHeader names the workspace for the account it is given, and reads no session', () => {
  it('a call without the account is a type error, and reads no session either', async () => {
    save('org-a', 'u1');
    // @ts-expect-error the account is required: a raw site names the session it sends
    await orgHeader();
    expect(supabaseMock.readDeviceAuthSession).not.toHaveBeenCalled();
    expect(supabaseMock.getSession).not.toHaveBeenCalled();
  });

  it("names the account's own saved workspace, and none for another account or nobody", async () => {
    save('org-a', 'u1');
    supabaseMock.readDeviceAuthSession.mockRejectedValue(new Error('keychain locked'));
    await expect(orgHeader('u1')).resolves.toEqual({ 'X-Organization-Id': 'org-a' });
    await expect(orgHeader('u2')).resolves.toEqual({});
    await expect(orgHeader(null)).resolves.toEqual({});
    expect(supabaseMock.readDeviceAuthSession).not.toHaveBeenCalled();
    supabaseMock.readDeviceAuthSession.mockReset();
  });

  it('names a workspace saved by an older build (no owner) for anyone, as before', async () => {
    save('org-a');
    await expect(orgHeader('u2')).resolves.toEqual({ 'X-Organization-Id': 'org-a' });
    await expect(orgHeader(null)).resolves.toEqual({ 'X-Organization-Id': 'org-a' });
  });

  it('nothing saved names nothing', async () => {
    await expect(orgHeader('u2')).resolves.toEqual({});
  });
});

/**
 * THE SCREENS THAT CALL FETCH THEMSELVES, executed. Each one imports native
 * modules, so vitest cannot load it; the `headers` object each one sends is
 * read from its source and evaluated as written, against the real orgHeader,
 * with the session the screen holds bound to its own name. That is the code
 * the review found reading the stored session on its own.
 */
type Headers = Record<string, string>;
type RawSite = { where: string; evaluate: (bindings: Record<string, unknown>) => Promise<Headers> };

const APP_DIR = path.resolve(__dirname, '../../app');

function rawFetchSites(): RawSite[] {
  const sites: RawSite[] = [];
  for (const file of listTsx(APP_DIR)) {
    const src = readSource(file);
    if (!src.includes('Bearer ${')) continue;
    const sf = parseTsx(src, file);
    const visit = (n: ts.Node) => {
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText(sf) === 'headers' &&
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.getText(sf).includes('Bearer ${')
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        const js = ts
          .transpile(`(async () => (${n.initializer.getText(sf)}))`, {
            target: ts.ScriptTarget.ES2020,
          })
          .trim()
          .replace(/;$/, '');
        sites.push({
          where: `app/${path.relative(APP_DIR, file)}:${line + 1}`,
          evaluate: (bindings) => {
            const names = Object.keys(bindings);
            // The site's own expression, with its free names bound.
            const build = new Function(...names, `return ${js};`) as (
              ...values: unknown[]
            ) => () => Promise<Headers>;
            return build(...names.map((name) => bindings[name]))();
          },
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

const SITES = rawFetchSites();

/** The session a screen holds for account A, under every name a site uses for it. */
const SESSION_A = { access_token: 'token-a', user: { id: 'u-a' } };
const AS_SCREEN_HOLDS_A = {
  session: SESSION_A,
  sender: SESSION_A,
  fresh: SESSION_A,
  token: SESSION_A.access_token,
  orgHeader,
};

describe('every screen that calls fetch itself names the workspace of the session it sends', () => {
  it('finds the PO scan, the AI count photo and its two saves, and the two chat requests', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(SITES.map((s) => [s.where, s] as const))(
    '%s: saved by A, session A, stored session unreadable: names the workspace',
    async (_where, site) => {
      save('org-a', 'u-a');
      supabaseMock.readDeviceAuthSession.mockRejectedValue(new Error('keychain locked'));
      const headers = await site.evaluate(AS_SCREEN_HOLDS_A);
      expect(headers.Authorization).toBe('Bearer token-a');
      expect(headers['X-Organization-Id']).toBe('org-a');
      supabaseMock.readDeviceAuthSession.mockReset();
    },
  );

  it.each(SITES.map((s) => [s.where, s] as const))(
    '%s: saved by B, session A: names none, whichever session is stored',
    async (_where, site) => {
      save('org-b', 'u-b');
      // B's session stored (an account change under way) and an unreadable one.
      supabaseMock.readDeviceAuthSession.mockResolvedValueOnce({ present: true, userId: 'u-b' });
      expect(await site.evaluate(AS_SCREEN_HOLDS_A)).not.toHaveProperty('X-Organization-Id');
      supabaseMock.readDeviceAuthSession.mockRejectedValueOnce(new Error('keychain locked'));
      expect(await site.evaluate(AS_SCREEN_HOLDS_A)).not.toHaveProperty('X-Organization-Id');
      supabaseMock.readDeviceAuthSession.mockReset();
    },
  );

  it.each(SITES.map((s) => [s.where, s] as const))(
    '%s: saved by an older build (no owner): names it, as before',
    async (_where, site) => {
      save('org-a');
      supabaseMock.readDeviceAuthSession.mockRejectedValue(new Error('keychain locked'));
      expect((await site.evaluate(AS_SCREEN_HOLDS_A))['X-Organization-Id']).toBe('org-a');
      supabaseMock.readDeviceAuthSession.mockReset();
    },
  );
});
