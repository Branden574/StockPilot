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
 *   'clear'   a membership read returned the workspace, and its policy does
 *             not require one of this role or the account has a verified
 *             factor;
 *   'unknown' anything else: nothing read for this account and workspace, a
 *             workspace missing from the read (absence is not evidence that
 *             nothing is owed: the read may be partial, or not return a
 *             membership), a policy that requires one with no factor list
 *             read yet, or a hidden row (held to the strictest policy) with
 *             no verified factor.
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
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * One key per account, `workspace.setUpInputs.<userId>`, holding that
 * account's inputs only: `{ v: 1, orgs: { [orgId]: WorkspaceSetUpInputs } }`
 * (workspace ids, the policy as read, the role and the workspace name). Under
 * the `workspace.` prefix, so a sign-out, an eviction and an account deletion
 * remove it with the account's other keys (account-eviction.ts
 * accountScopedStorageKeys), right after forgetSetUpInputs below.
 */
export const SET_UP_INPUTS_STORAGE_PREFIX = 'workspace.setUpInputs.';

export function setUpInputsStorageKey(userId: string): string {
  return `${SET_UP_INPUTS_STORAGE_PREFIX}${userId}`;
}

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
/**
 * The number taken by the last forgetSetUpInputs: a read that started at or
 * before it belongs to accounts that were signed out, and records nothing.
 */
let forgottenAt = 0;
/** Bumped by forgetSetUpInputs: a load of saved inputs started earlier brings nothing back. */
let forgetCount = 0;

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
  // Started before a sign-out: that account's inputs are gone with it.
  if (readSeq <= forgottenAt) return;
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
  save(userId, orgs);
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
  if (at <= forgottenAt) return;
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
  // Missing from the read: nothing is known of that workspace's policy for
  // this account, so only a read that returns it can answer 'clear'.
  if (!inputs) return 'unknown';
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

/** One account's saved value as kept inputs, or null when it is not one; a malformed workspace is dropped. */
export function parseSavedSetUpInputs(
  raw: string | null,
): Record<string, WorkspaceSetUpInputs> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const orgs = (parsed as { v?: unknown; orgs?: unknown } | null)?.orgs;
  if ((parsed as { v?: unknown } | null)?.v !== 1 || !orgs || typeof orgs !== 'object') {
    return null;
  }
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
  return kept;
}

/** Writes this account's inputs under its own key, after any write still waiting. */
function save(userId: string, orgs: Record<string, WorkspaceSetUpInputs>): void {
  const target = storage;
  if (!target) return;
  const value = JSON.stringify({ v: 1, orgs });
  saveChain = saveChain
    .then(() => target.setItem(setUpInputsStorageKey(userId), value))
    .catch(() => undefined);
}

/** What an earlier run saved, for accounts this run has not read yet. Never throws. */
async function loadSaved(target: SetUpInputsStorage): Promise<void> {
  const startedAt = forgetCount;
  let keys: readonly string[] = [];
  try {
    keys = (await target.getAllKeys()).filter((k) => k.startsWith(SET_UP_INPUTS_STORAGE_PREFIX));
  } catch {
    return;
  }
  for (const key of keys) {
    const userId = key.slice(SET_UP_INPUTS_STORAGE_PREFIX.length);
    if (!userId) continue;
    let raw: string | null = null;
    try {
      raw = await target.getItem(key);
    } catch {
      continue;
    }
    // A sign-out while this load was out: what it read is gone with it.
    if (forgetCount !== startedAt) return;
    const orgs = parseSavedSetUpInputs(raw);
    if (orgs && !memberships.has(userId)) memberships.set(userId, { orgs, readSeq: null });
  }
}

/**
 * THE SIGN-OUT, THE EVICTION AND AN ACCOUNT DELETION. Forgets every account's
 * inputs, factor lists and refusal marks held this run, and stops any read
 * or load already under way from recording them again. Resolves once every
 * save already asked for has landed, so the wipe of the account keys that
 * follows it (clearAccountStorage in auth-context.tsx and use-account-gate.ts)
 * removes them too. Every account's, as that wipe removes every
 * account-scoped key. Never throws.
 */
export async function forgetSetUpInputs(): Promise<void> {
  forgottenAt = beginSetUpRead();
  forgetCount += 1;
  memberships.clear();
  factors.clear();
  refusals.clear();
  await saveChain.catch(() => undefined);
}

/**
 * Registered once (set-up-inputs-source.ts): where the inputs are saved, and the
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
  forgottenAt = 0;
  forgetCount = 0;
}
