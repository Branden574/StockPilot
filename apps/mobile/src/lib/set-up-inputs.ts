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
 *   - the drain rule (drain-failure.ts): a 403 on a queued send that names no
 *     reason is final only when this store, from reads that STARTED after
 *     that row's own kept refusal, answers 'clear' for the row's workspace
 *     (setUpAnswerAfterRefusal).
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
 *   - the holding screen's decision (set-up-hold.ts), through the view below
 *     (setUpInputsView), the outcome of each read, a listener, and reads of
 *     its own: one that can be awaited (readSetUpInputsForHold) and a plain
 *     ask for an authenticator answer from any route (askForSetUpRead). Its
 *     reads write here like every other read, so a row the queue holds is
 *     released by the same answer that lets the member in. They never set a
 *     refusal mark and never move the queue's minimum interval.
 *
 * A LEAF: core only. AsyncStorage and the reads are handed in by
 * set-up-inputs-source.ts (registerSetUpInputsSource), so the drains and the
 * send decision import nothing native.
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

/**
 * At most one read asked for by the drains per this many milliseconds, for
 * held rows and kept refusals alike, however many rows asked.
 */
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

interface FactorList {
  hasVerified: boolean;
  readSeq: number;
}

interface AccountFactors {
  /** The newest list, however it was numbered: what the hold decides by. */
  latest: FactorList;
  /**
   * The newest list from a read that took its number as it STARTED (the
   * store's own read). Only this one can answer for a refusal: a list
   * numbered on arrival may come from a read that started before it.
   */
  started: FactorList | null;
}

const factors = new Map<string, AccountFactors>();

/**
 * Each queued row's kept refusal: `${userId}\u0000${orgId}\u0000${rowKey}` ->
 * its number. `rowKey` is the row's idempotency key. Two live rows never
 * share one, and the drains delete a row's mark when the row leaves the
 * queue (forgetRowRefusal), so a key queued again later starts with none and
 * the map holds only rows still queued.
 */
const refusals = new Map<string, number>();

/**
 * How a read ended: 'answered' (the membership read returned rows),
 * 'failed' (the server answered with an error), 'no-answer' (no connection,
 * or no answer in time).
 */
export type SetUpReadOutcome = 'answered' | 'failed' | 'no-answer';

/** Each account's latest read outcome, by the number the read took at its start. */
const readOutcomes = new Map<string, { outcome: SetUpReadOutcome; readSeq: number }>();

/** Told after every change of what is kept (the holding screen's decision). */
const listeners = new Set<() => void>();

/**
 * The read registered by set-up-inputs-source.ts. `forUserId` is the account
 * the holding screen reads for, so a read that ends before the user is known
 * is still recorded for it; the queue's reads pass nothing.
 */
type SetUpInputsReader = (forUserId?: string | null) => Promise<void>;

let storage: SetUpInputsStorage | null = null;
let reader: SetUpInputsReader | null = null;
let readInFlight: Promise<void> | null = null;
/** The one read queued behind a read in flight for the holding screen. */
let followUp: Promise<void> | null = null;
/** The account that follow-up reads for: the last one named by a caller that joined it. */
let followUpFor: string | null = null;
let lastAskAt = -Infinity;
let lastReadAskedAt = -Infinity;
let saveChain: Promise<void> = Promise.resolve();
/**
 * The number taken by the last forgetSetUpInputs: a read that started at or
 * before it belongs to accounts that were signed out, and records nothing.
 */
let forgottenAt = 0;
/** Bumped by forgetSetUpInputs: a load of saved inputs started earlier brings nothing back. */
let forgetCount = 0;

const refusalKey = (userId: string, orgId: string, rowKey: string) =>
  `${userId}\u0000${orgId}\u0000${rowKey}`;

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
  keepOutcome(userId, readSeq, 'answered');
  changed();
}

/**
 * A membership read for this account ended without rows: `answered` when
 * the server answered with an error, false when no answer came (no
 * connection). What was kept stays; only the outcome is recorded.
 */
export function noteMembershipReadFailed(userId: string, readSeq: number, answered: boolean): void {
  noteSetUpReadOutcome(userId, readSeq, answered ? 'failed' : 'no-answer');
}

/** How a read for this account ended (`readSeq` from beginSetUpRead at its start). */
export function noteSetUpReadOutcome(
  userId: string | null | undefined,
  readSeq: number,
  outcome: SetUpReadOutcome,
): void {
  if (typeof userId !== 'string' || !userId) return;
  if (keepOutcome(userId, readSeq, outcome)) changed();
}

/** Keeps the outcome unless a read that started later already ended; true when kept. */
function keepOutcome(userId: string, readSeq: number, outcome: SetUpReadOutcome): boolean {
  if (readSeq <= forgottenAt) return false;
  const current = readOutcomes.get(userId);
  if (current && current.readSeq > readSeq) return false;
  readOutcomes.set(userId, { outcome, readSeq });
  return true;
}

/** Tells every listener; one that throws never stops the others or the caller. */
function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A listener's own failure is its own.
    }
  }
}

/** Told after every change of the inputs, factor lists, outcomes or a sign-out. */
export function subscribeSetUpInputs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * A user the app read from the server. Its factor list replaces the one kept
 * for that account. `readSeq` is the number the read took at its start, when
 * the caller has it; otherwise the next one, taken on arrival (such a list
 * decides the hold, never a refusal). A factor list that is not a list is
 * not read: nothing is recorded.
 */
export function noteServerReadUser(
  user: ServerReadUser | null | undefined,
  readSeq?: number,
): void {
  const id = user?.id;
  if (typeof id !== 'string' || !id) return;
  const list: unknown = user?.factors ?? [];
  if (!Array.isArray(list)) return;
  const at = readSeq ?? beginSetUpRead();
  if (at <= forgottenAt) return;
  const read: FactorList = {
    hasVerified: list.some(
      (factor: { status?: unknown } | null | undefined) => factor?.status === 'verified',
    ),
    readSeq: at,
  };
  const current = factors.get(id);
  const latest = current && current.latest.readSeq > at ? current.latest : read;
  let started = current?.started ?? null;
  if (readSeq !== undefined && (!started || started.readSeq <= at)) started = read;
  factors.set(id, { latest, started });
  changed();
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
  const kept = factors.get(userId);
  const list = after === null ? kept?.latest : kept?.started;
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

/** What is kept for one account and workspace, for the holding screen (set-up-hold.ts). */
export interface SetUpInputsView {
  /** The workspace's inputs, or null when the kept memberships do not hold it (or none are kept). */
  inputs: WorkspaceSetUpInputs | null;
  /** Where the kept memberships come from: a read this run, an earlier run's save, or nothing kept. */
  membershipsFrom: 'this-run' | 'saved' | null;
  /** Whether the server's newest factor list read this run has a verified factor; null when none was read. */
  serverHasVerified: boolean | null;
  /** How this account's latest read ended; null when none has ended this run. */
  lastRead: SetUpReadOutcome | null;
}

export function setUpInputsView(userId: string | null, orgId: string | null): SetUpInputsView {
  if (!userId) {
    return { inputs: null, membershipsFrom: null, serverHasVerified: null, lastRead: null };
  }
  const account = memberships.get(userId);
  const list = factors.get(userId)?.latest;
  return {
    inputs: (account && orgId ? account.orgs[orgId] : undefined) ?? null,
    membershipsFrom: !account ? null : account.readSeq === null ? 'saved' : 'this-run',
    serverHasVerified: list ? list.hasVerified : null,
    lastRead: readOutcomes.get(userId)?.outcome ?? null,
  };
}

/** One workspace kept for an account: its id and its name as read (null when its row could not be read). */
export interface KeptWorkspace {
  orgId: string;
  name: string | null;
}

const NO_WORKSPACES: readonly KeptWorkspace[] = Object.freeze([]);
/** Each kept membership set's list, made once: the holding screen reads it in render. */
const workspaceLists = new WeakMap<AccountMemberships, readonly KeptWorkspace[]>();

/**
 * The workspaces kept for this account (this run's read, else an earlier
 * run's save), in the order read. The same array until what is kept
 * changes. Organizations only: nothing of a workspace's contents is kept.
 */
export function keptWorkspacesFor(userId: string | null): readonly KeptWorkspace[] {
  const account = userId ? memberships.get(userId) : undefined;
  if (!account) return NO_WORKSPACES;
  let list = workspaceLists.get(account);
  if (!list) {
    list = Object.freeze(
      Object.entries(account.orgs).map(([orgId, inputs]) => ({ orgId, name: inputs.name })),
    );
    workspaceLists.set(account, list);
  }
  return list;
}

/**
 * For a 403 on a queued send: the answer from reads that STARTED after THIS
 * row's kept refusal (noteKeptRefusal), else 'unknown'. A row with no kept
 * refusal answers 'unknown', so each row's first refusal is never final: it
 * is kept, the inputs are read again, and only a later refusal of that row
 * can be. Another row's refusal, and any read that started before this
 * row's, never answer for it.
 */
export function setUpAnswerAfterRefusal(
  userId: string | null,
  orgId: string | null,
  rowKey: string | null,
): SetUpAnswer {
  if (!userId || !orgId || !rowKey) return 'unknown';
  const refusedAt = refusals.get(refusalKey(userId, orgId, rowKey));
  if (refusedAt === undefined) return 'unknown';
  return answer(userId, orgId, refusedAt);
}

/** Whether this row has a refusal kept for a check this app run (the drain backs it off). */
export function keptRefusalNoted(
  userId: string | null,
  orgId: string | null,
  rowKey: string | null,
): boolean {
  if (!userId || !orgId || !rowKey) return false;
  return refusals.has(refusalKey(userId, orgId, rowKey));
}

/**
 * A 403 on a queued row was kept for a check. Records the row's mark: its
 * first kept refusal, moved on to a later one only once a membership read
 * that started after the mark has answered (until then the read already
 * asked for still counts). Then asks for a read, under the same minimum
 * interval as held rows, so one pass with many kept rows asks for one.
 */
export function noteKeptRefusal(
  userId: string | null,
  orgId: string | null,
  rowKey: string | null,
): void {
  if (!userId || !orgId || !rowKey) return;
  const key = refusalKey(userId, orgId, rowKey);
  const pending = refusals.get(key);
  const account = memberships.get(userId);
  const answeredSince =
    pending !== undefined && account?.readSeq != null && account.readSeq > pending;
  if (pending === undefined || answeredSince) refusals.set(key, beginSetUpRead());
  requestSetUpInputsRead(Date.now());
}

/**
 * The row left the queue (acked, or parked): its mark goes, whichever
 * account and workspace it was kept under. A row queued later with the same
 * key starts with no mark.
 */
export function forgetRowRefusal(rowKey: string | null | undefined): void {
  if (!rowKey) return;
  const suffix = `\u0000${rowKey}`;
  for (const key of [...refusals.keys()]) {
    if (key.endsWith(suffix)) refusals.delete(key);
  }
}

/** Tests only: how many row marks are kept. */
export function keptRefusalCountForTests(): number {
  return refusals.size;
}

// ── Reads asked for ──────────────────────────────────────────────────────

/** One read at a time; nothing when no reader is registered. Never throws, even when the reader does. */
function startRead(now: number): void {
  if (!reader || readInFlight) return;
  lastReadAskedAt = now;
  let started: Promise<void>;
  try {
    started = reader();
  } catch {
    return;
  }
  readInFlight = Promise.resolve(started)
    .catch(() => undefined)
    .finally(() => {
      readInFlight = null;
    });
}

/**
 * Ask for the inputs to be read again (the user and the membership read): for
 * rows held while set-up is owed, that read is what releases them once the
 * account has an authenticator or the policy changed; for a kept refusal
 * (noteKeptRefusal), it is the check the row's next refusal is judged on. At
 * most one per SET_UP_READ_MIN_INTERVAL_MS, since every drain pass and every
 * kept row asks.
 */
export function requestSetUpInputsRead(now: number = Date.now()): void {
  if (now - lastReadAskedAt < SET_UP_READ_MIN_INTERVAL_MS) return;
  startRead(now);
}

/** The read asked for last, if one is running (tests and callers that wait for it). */
export function setUpInputsReadInFlight(): Promise<void> | null {
  return readInFlight;
}

/**
 * Starts a read for the holding screen. Like startRead, but it leaves the
 * queue's interval (lastReadAskedAt) as it was. Only called with no read in
 * flight. Never rejects, even when the reader throws.
 */
function startHoldRead(forUserId: string | null): Promise<void> {
  if (!reader) return Promise.resolve();
  let started: Promise<void>;
  try {
    started = reader(forUserId);
  } catch {
    return Promise.resolve();
  }
  const run = Promise.resolve(started)
    .catch(() => undefined)
    .finally(() => {
      if (readInFlight === run) readInFlight = null;
    });
  readInFlight = run;
  return run;
}

/**
 * THE HOLDING SCREEN'S READ: the user and the memberships read again, for
 * sign-in, a cold launch, the return to the foreground, the connection
 * coming back, a workspace switch and "Check again". Not throttled. Resolves
 * once a read that STARTED after this call has ended: with a read already in
 * flight (it may have started before the member set up the authenticator),
 * one more read runs after it, shared by every caller meanwhile. Never
 * rejects. What it reads is written here, so the queue's held rows follow it.
 */
export function readSetUpInputsForHold(forUserId: string | null): Promise<void> {
  if (!reader) return Promise.resolve();
  if (!readInFlight) return startHoldRead(forUserId);
  if (forUserId || !followUp) followUpFor = forUserId;
  if (!followUp) {
    const next = readInFlight.then(() => {
      followUp = null;
      const forWhom = followUpFor;
      followUpFor = null;
      // A read the queue started in between began after this call: it serves.
      return readInFlight ?? startHoldRead(forWhom);
    });
    followUp = next;
  }
  return followUp;
}

/** At most one read asked for by askForSetUpRead per this many milliseconds. */
export const SET_UP_ASK_MIN_INTERVAL_MS = 10_000;

/**
 * Ask for the inputs to be read again, from any screen: a route answered
 * that this account must set up an authenticator first. It only asks: the
 * hold comes up only if the read finds set-up owed. At most one per
 * SET_UP_ASK_MIN_INTERVAL_MS. An ask that arrives while a read is in flight
 * (one that may have started before the policy changed) is kept as the one
 * read after it (readSetUpInputsForHold). The queue's own interval and
 * refusal marks are left as they were.
 */
export function askForSetUpRead(now: number = Date.now()): void {
  if (!reader) return;
  if (now - lastAskAt < SET_UP_ASK_MIN_INTERVAL_MS) return;
  lastAskAt = now;
  void readSetUpInputsForHold(null);
}

/** For api(): a 403 whose `details.reason` is 'mfa_required' asks for a read; nothing else does. */
export function askForSetUpReadOnRefusal(
  status: number,
  details: unknown,
  now: number = Date.now(),
): void {
  if (status !== 403 || details === null || typeof details !== 'object') return;
  if ((details as { reason?: unknown }).reason === 'mfa_required') askForSetUpRead(now);
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
  try {
    await loadSavedInputs(target);
  } finally {
    changed();
  }
}

async function loadSavedInputs(target: SetUpInputsStorage): Promise<void> {
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
  readOutcomes.clear();
  changed();
  await saveChain.catch(() => undefined);
}

/** Bumped at every forgetSetUpInputs (set-up-hold.ts drops the saved workspace it read before). */
export function setUpInputsForgetCount(): number {
  return forgetCount;
}

/**
 * Registered once (set-up-inputs-source.ts): where the inputs are saved, and the
 * read the outbox may ask for. Loads what an earlier run saved. Returns when
 * that load has finished (callers need not wait).
 */
export function registerSetUpInputsSource(source: {
  storage: SetUpInputsStorage;
  read: SetUpInputsReader;
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
  readOutcomes.clear();
  listeners.clear();
  storage = null;
  reader = null;
  readInFlight = null;
  followUp = null;
  followUpFor = null;
  lastAskAt = -Infinity;
  lastReadAskedAt = -Infinity;
  saveChain = Promise.resolve();
  forgottenAt = 0;
  forgetCount = 0;
}
