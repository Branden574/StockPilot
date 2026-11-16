import {
  authenticatorSetUpOwed,
  policyRequiresAuthenticator,
  readOrganizationMfaPolicy,
  UNREADABLE_ORG_MFA_POLICY,
  type OrganizationMfaPolicy,
} from '@stockpilot/core';

/**
 * DOES THIS ACCOUNT OWE AUTHENTICATOR SET-UP IN THIS WORKSPACE?
 *
 * The inputs to core's rule (`authenticatorSetUpOwed`), kept per account and
 * per workspace: the workspace's policy AS READ (or 'hidden' when its row
 * could not be read) and the account's role there, from the membership read
 * (use-workspace.ts loadOrgs); the account's factor list, from the user the
 * app last read from the server (mfa-reconcile.ts hands every one over).
 * The ANSWER is worked out when asked, never stored.
 *
 * Who asks:
 *   - the outbox send decision (outbox-scope.ts): a queued row whose own
 *     workspace answers 'owed' is held, left exactly as it is, until the
 *     account has an authenticator;
 *   - the drain rule (drain-failure.ts): a 403 on a queued send is final only
 *     when this store, from reads made AFTER that refusal, answers 'clear'
 *     for the row's workspace (setUpAnswerAfterRefusal).
 *
 * Answers:
 *   'owed'    the policy, as read, requires an authenticator of this role and
 *             the server's factor list has no verified one;
 *   'clear'   the policy does not require one of this role, the account has a
 *             verified factor, or a membership read this run answered and the
 *             account is not a member of the workspace (no policy of it
 *             applies to this account);
 *   'unknown' anything else: nothing read for this account and workspace, a
 *             policy that requires one with no factor list read yet, or a
 *             hidden row (held to the strictest policy) with no verified
 *             factor.
 *
 * A LEAF: core only. AsyncStorage and the reads are handed in by
 * use-workspace.ts (registerSetUpInputsSource), so the drains and the send
 * decision import nothing native.
 */

export type SetUpAnswer = 'owed' | 'clear' | 'unknown';

/** The policy as the membership read saw it, or 'hidden' when the row was not read. */
export type PolicyAsRead = OrganizationMfaPolicy | 'hidden';

/** What is kept for one workspace of one account (the inputs, never the answer). */
export interface WorkspaceSetUpInputs {
  policy: PolicyAsRead;
  role: string;
  /** The workspace's name as read, for the holding screen; null when hidden. */
  name: string | null;
}

/** One membership row as the read returns it (the embed is an object or an array). */
export interface MembershipRowForSetUp {
  organizationId: string;
  role: string;
  /** The `organizations:organization_id (name, mfa_policy)` embed, as returned. */
  organization: unknown;
}

/** A user as the server returned it; only `id` and each factor's `status` are read. */
export interface ServerReadUser {
  id?: string | null;
  factors?: readonly ({ readonly status?: string | null } | null | undefined)[] | null;
}

/** The storage this store saves its inputs to (AsyncStorage in the app). */
export interface SetUpInputsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * One JSON value for every account on the device: `{ v: 1, accounts: { [userId]:
 * { [orgId]: WorkspaceSetUpInputs } } }`. Under the `workspace.` prefix, so a
 * sign-out and an eviction remove it with the account's other keys
 * (account-eviction.ts accountScopedStorageKeys).
 */
export const SET_UP_INPUTS_STORAGE_KEY = 'workspace.setUpInputs';

/** At most one read asked for by held rows per this many milliseconds. */
export const SET_UP_READ_MIN_INTERVAL_MS = 30_000;

// ── State (this app run) ─────────────────────────────────────────────────

/**
 * A counter, not a clock: every read takes the next number when it STARTS,
 * and every refusal kept for a check takes the next one when it is noted, so
 * "read after the refusal" is a plain comparison.
 */
let seq = 0;

interface AccountMemberships {
  orgs: Record<string, WorkspaceSetUpInputs>;
  /** The number the read took at its start; null when loaded from storage (an earlier run). */
  readSeq: number | null;
}

const memberships = new Map<string, AccountMemberships>();

interface AccountFactors {
  hasVerified: boolean;
  readSeq: number;
}

const factors = new Map<string, AccountFactors>();

/** The refusal each account and workspace is waiting for a check of: `${userId}\u0000${orgId}` -> its number. */
const refusals = new Map<string, number>();

let storage: SetUpInputsStorage | null = null;
let reader: (() => Promise<void>) | null = null;
let readInFlight: Promise<void> | null = null;
let lastReadAskedAt = -Infinity;
let saveChain: Promise<void> = Promise.resolve();

const refusalKey = (userId: string, orgId: string) => `${userId}\u0000${orgId}`;

// ── Recording what was read ──────────────────────────────────────────────

/** The number a read takes as it starts. Pass it back with what it read. */
export function beginSetUpRead(): number {
  seq += 1;
  return seq;
}

/** One embed as kept: the policy as read ('hidden' when not read) and the name. */
function inputsFromRow(row: MembershipRowForSetUp): WorkspaceSetUpInputs {
  const policy = readOrganizationMfaPolicy(
    row.organization as Parameters<typeof readOrganizationMfaPolicy>[0],
  );
  const embed = Array.isArray(row.organization) ? row.organization[0] : row.organization;
  const rawName =
    embed && typeof embed === 'object' ? (embed as { name?: unknown }).name : undefined;
  return {
    policy: policy ?? 'hidden',
    role: row.role,
    name: policy !== null && typeof rawName === 'string' ? rawName : null,
  };
}

/**
 * A membership read for this account ANSWERED: its rows replace what was kept
 * for the account (a workspace it has left is gone), and are saved.
 * `readSeq` is what beginSetUpRead gave the read as it started.
 */
export function recordMembershipInputs(
  userId: string,
  rows: readonly MembershipRowForSetUp[],
  readSeq: number,
): void {
  const current = memberships.get(userId);
  // A slower read that started before the one already kept says less.
  if (current && current.readSeq !== null && current.readSeq > readSeq) return;
  const orgs: Record<string, WorkspaceSetUpInputs> = {};
  for (const row of rows) {
    if (typeof row.organizationId !== 'string' || !row.organizationId) continue;
    if (typeof row.role !== 'string') continue;
    orgs[row.organizationId] = inputsFromRow(row);
  }
  memberships.set(userId, { orgs, readSeq });
  save();
}

/**
 * A user the app read from the server. Its factor list replaces the one kept
 * for that account. `readSeq` is the number the read took at its start, when
 * the caller has it; otherwise the next one (the answer is at least that new).
 */
export function noteServerReadUser(
  user: ServerReadUser | null | undefined,
  readSeq?: number,
): void {
  const id = user?.id;
  if (typeof id !== 'string' || !id) return;
  const at = readSeq ?? beginSetUpRead();
  const current = factors.get(id);
  if (current && current.readSeq > at) return;
  factors.set(id, {
    hasVerified: (user?.factors ?? []).some((factor) => factor?.status === 'verified'),
    readSeq: at,
  });
}

// ── Answers ──────────────────────────────────────────────────────────────

/** The answer from what is kept, optionally only from reads made after `after`. */
function answer(userId: string | null, orgId: string | null, after: number | null): SetUpAnswer {
  if (!userId || !orgId) return 'unknown';
  const account = memberships.get(userId);
  if (!account) return 'unknown';
  if (after !== null && (account.readSeq === null || account.readSeq <= after)) return 'unknown';
  const inputs = account.orgs[orgId];
  // Not among this account's memberships: from a read this run, no policy of
  // that workspace applies to this account; from storage, nothing is known.
  if (!inputs) return account.readSeq !== null ? 'clear' : 'unknown';
  // A row that could not be read is held to the strictest policy, never read
  // as the organization's own (core readOrganizationMfaPolicy).
  const policy = inputs.policy === 'hidden' ? UNREADABLE_ORG_MFA_POLICY : inputs.policy;
  if (!policyRequiresAuthenticator(policy, inputs.role)) return 'clear';
  const list = factors.get(userId);
  if (!list) return 'unknown';
  if (after !== null && list.readSeq <= after) return 'unknown';
  const owed = authenticatorSetUpOwed(
    policy,
    inputs.role,
    list.hasVerified ? [{ status: 'verified' }] : [],
  );
  if (!owed) return 'clear';
  return inputs.policy === 'hidden' ? 'unknown' : 'owed';
}

/** The answer from what is known: this run's reads, else what an earlier run saved. */
export function setUpOwedIn(userId: string | null, orgId: string | null): SetUpAnswer {
  return answer(userId, orgId, null);
}

/**
 * For a 403 on a queued send: the answer from reads that STARTED after the
 * last refusal kept for this account and workspace (noteKeptRefusal), else
 * 'unknown'. So the first refusal is never final: it is kept, the inputs are
 * read again, and only the next send's refusal can be.
 */
export function setUpAnswerAfterRefusal(userId: string | null, orgId: string | null): SetUpAnswer {
  if (!userId || !orgId) return 'unknown';
  const refusedAt = refusals.get(refusalKey(userId, orgId));
  if (refusedAt === undefined) return 'unknown';
  return answer(userId, orgId, refusedAt);
}

/**
 * A 403 on a queued send was kept for a check. Records it (unless an earlier
 * one is still waiting for a read made after it: moving that mark on would
 * let a burst of refusals outrun every read) and asks for a read.
 */
export function noteKeptRefusal(userId: string | null, orgId: string | null): void {
  if (!userId || !orgId) return;
  const key = refusalKey(userId, orgId);
  const pending = refusals.get(key);
  const account = memberships.get(userId);
  const answeredSince =
    pending !== undefined && account?.readSeq != null && account.readSeq > pending;
  if (pending === undefined || answeredSince) refusals.set(key, beginSetUpRead());
  startRead(Date.now());
}

// ── Reads asked for ──────────────────────────────────────────────────────

/** One read at a time; nothing when no reader is registered. Never throws. */
function startRead(now: number): void {
  if (!reader || readInFlight) return;
  lastReadAskedAt = now;
  readInFlight = reader()
    .catch(() => undefined)
    .finally(() => {
      readInFlight = null;
    });
}

/**
 * Ask for the inputs to be read again (the user and the membership read), for
 * rows held while set-up is owed: that read is what releases them once the
 * account has an authenticator or the policy changed. At most one per
 * SET_UP_READ_MIN_INTERVAL_MS, since every drain pass asks. A refusal kept
 * for a check asks through noteKeptRefusal, without that wait.
 */
export function requestSetUpInputsRead(now: number = Date.now()): void {
  if (now - lastReadAskedAt < SET_UP_READ_MIN_INTERVAL_MS) return;
  startRead(now);
}

/** The read asked for last, if one is running (tests and callers that wait for it). */
export function setUpInputsReadInFlight(): Promise<void> | null {
  return readInFlight;
}

// ── Saving and loading ───────────────────────────────────────────────────

function isPolicyAsRead(v: unknown): v is PolicyAsRead {
  return v === 'optional' || v === 'admins_required' || v === 'all_required' || v === 'hidden';
}

/** The saved value as kept inputs; anything malformed is dropped. */
export function parseSavedSetUpInputs(
  raw: string | null,
): Map<string, Record<string, WorkspaceSetUpInputs>> {
  const out = new Map<string, Record<string, WorkspaceSetUpInputs>>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const accounts = (parsed as { v?: unknown; accounts?: unknown } | null)?.accounts;
  if ((parsed as { v?: unknown } | null)?.v !== 1 || !accounts || typeof accounts !== 'object') {
    return out;
  }
  for (const [userId, orgs] of Object.entries(accounts as Record<string, unknown>)) {
    if (!userId || !orgs || typeof orgs !== 'object') continue;
    const kept: Record<string, WorkspaceSetUpInputs> = {};
    for (const [orgId, value] of Object.entries(orgs as Record<string, unknown>)) {
      const v = value as { policy?: unknown; role?: unknown; name?: unknown } | null;
      if (!orgId || !v || !isPolicyAsRead(v.policy) || typeof v.role !== 'string') continue;
      kept[orgId] = {
        policy: v.policy,
        role: v.role,
        name: typeof v.name === 'string' ? v.name : null,
      };
    }
    out.set(userId, kept);
  }
  return out;
}

function serialize(): string {
  const accounts: Record<string, Record<string, WorkspaceSetUpInputs>> = {};
  for (const [userId, account] of memberships) accounts[userId] = account.orgs;
  return JSON.stringify({ v: 1, accounts });
}

function save(): void {
  const target = storage;
  if (!target) return;
  saveChain = saveChain
    .then(() => target.setItem(SET_UP_INPUTS_STORAGE_KEY, serialize()))
    .catch(() => undefined);
}

/** What an earlier run saved, for accounts this run has not read yet. Never throws. */
async function loadSaved(target: SetUpInputsStorage): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await target.getItem(SET_UP_INPUTS_STORAGE_KEY);
  } catch {
    return;
  }
  for (const [userId, orgs] of parseSavedSetUpInputs(raw)) {
    if (!memberships.has(userId)) memberships.set(userId, { orgs, readSeq: null });
  }
}

/**
 * Registered once by use-workspace.ts: where the inputs are saved, and the
 * read the outbox may ask for. Loads what an earlier run saved. Returns when
 * that load has finished (callers need not wait).
 */
export function registerSetUpInputsSource(source: {
  storage: SetUpInputsStorage;
  read: () => Promise<void>;
}): Promise<void> {
  storage = source.storage;
  reader = source.read;
  return loadSaved(source.storage);
}

/** Tests only: back to an empty store with nothing registered. */
export function resetSetUpInputsForTests(): void {
  seq = 0;
  memberships.clear();
  factors.clear();
  refusals.clear();
  storage = null;
  reader = null;
  readInFlight = null;
  lastReadAskedAt = -Infinity;
  saveChain = Promise.resolve();
}
