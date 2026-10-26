import { beforeEach, describe, expect, it, vi } from 'vitest';

import { endAccountEpoch } from './account-epoch';
import { forgetCloseGates, fetchCountCloseGate, rememberedCloseGate } from './count-close-gate';
import { forgetListViews, recallListView, rememberListView } from './cycle-count-history';
import {
  forgetRememberedExceptions,
  recalledDetail,
  recalledList,
  rememberDetail,
  rememberList,
  type MobileExceptionDetail,
  type MobileExceptionList,
} from './exceptions-api';
import { countSelection } from './use-count-selection';
import './use-workspace';

/**
 * What the phone keeps IN MEMORY about the signed-in account goes when the
 * account does (B25, #242 follow-up "clear the count cache on sign-out").
 *
 * THE DEFECT. A sign-out ends the session, not the app process, and four
 * module-level memories outlived it:
 *   - the count picker's selection (use-count-selection.ts), keyed by nothing:
 *     the next person to sign in on the phone found the previous account's
 *     items, names and SKUs from its organization, under "Count selected",
 *     and could start a count of them;
 *   - the count list's last search, filter and page per workspace
 *     (cycle-count-history.ts): a colleague in the same workspace opened the
 *     history on the previous person's search;
 *   - the count screen's Post and Cancel answer, and the exceptions shown
 *     offline (count-close-gate.ts, exceptions-api.ts): keyed by account, so
 *     never shown to another, but kept in memory for an account that left.
 *
 * Driven through the REAL auth listener use-workspace.ts registers at import,
 * which ends the account epoch when the signed-in user changes (a sign-out of
 * any kind, another account, an eviction's own end of the epoch).
 */

const auth = vi.hoisted(() => ({
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
const emitAuth = (id: string | null) =>
  auth.listener?.(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id } } : null);

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (fn: NonNullable<typeof auth.listener>) => {
        auth.listener = fn;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
    },
  },
}));
vi.mock('./auth-context', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock('./db', () => ({ deleteOrgData: vi.fn(async () => {}) }));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
vi.mock('./sync', () => ({ syncNow: vi.fn(async () => {}) }));
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

const PICK = { id: 'item-1', sku: 'SKU-1', name: 'Placeholder item', itemType: 'product' };
const VIEW = { q: 'cc-3', status: 'in_progress' as const, page: 2 };
const LIST = {
  organizationId: 'org-a',
  status: 'open',
  occurrences: [],
  truncated: false,
  syncState: null,
  canCheckNow: false,
} as unknown as MobileExceptionList;
const DETAIL = {
  organizationId: 'org-a',
  occurrence: { id: 'occ-1' },
} as unknown as MobileExceptionDetail;

/** u1 is signed in and has used every count memory. */
async function u1Remembers() {
  emitAuth('u1');
  countSelection.add([PICK]);
  rememberListView('org-a', VIEW);
  apiMock.api.mockResolvedValueOnce({ role: 'manager', permissions: ['stock:adjust'] });
  await fetchCountCloseGate('u1', 'org-a');
  rememberList('u1', 'org-a', LIST);
  rememberDetail('u1', 'org-a', DETAIL);
  // Each is there before the account changes.
  expect(countSelection.has('item-1')).toBe(true);
  expect(recallListView('org-a')).toEqual(VIEW);
  expect(rememberedCloseGate('u1', 'org-a')).toEqual({ canPost: true, canCancel: false });
  expect(recalledList('u1', 'org-a', 'open')?.list).toBe(LIST);
  expect(recalledDetail('u1', 'org-a', 'occ-1')?.detail).toBe(DETAIL);
}

function expectAllForgotten() {
  expect(countSelection.has('item-1')).toBe(false);
  expect(recallListView('org-a')).toEqual({ q: '', status: null, page: 1 });
  expect(rememberedCloseGate('u1', 'org-a')).toBeNull();
  expect(recalledList('u1', 'org-a', 'open')).toBeNull();
  expect(recalledDetail('u1', 'org-a', 'occ-1')).toBeNull();
}

beforeEach(() => {
  apiMock.api.mockReset();
  countSelection.clear();
  forgetListViews();
  forgetCloseGates();
  forgetRememberedExceptions();
  // The listener records who is signed in; start every test from u1.
  emitAuth('u1');
});

describe('an account change forgets what the phone remembered for the account', () => {
  it('a sign-out (any kind: the menu, "Use password instead", a revoked session)', async () => {
    await u1Remembers();
    emitAuth(null);
    expectAllForgotten();
  });

  it('another account signing in', async () => {
    await u1Remembers();
    emitAuth('u2');
    expectAllForgotten();
  });

  it('an eviction, which ends the epoch itself (use-account-gate.ts)', async () => {
    await u1Remembers();
    endAccountEpoch();
    expectAllForgotten();
  });

  it('a token refresh for the same account keeps everything', async () => {
    await u1Remembers();
    emitAuth('u1');
    expect(countSelection.has('item-1')).toBe(true);
    expect(recallListView('org-a')).toEqual(VIEW);
    expect(rememberedCloseGate('u1', 'org-a')).not.toBeNull();
    expect(recalledList('u1', 'org-a', 'open')).not.toBeNull();
  });
});
