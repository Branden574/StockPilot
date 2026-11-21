import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { cookies, headers } from 'next/headers';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeAttestationObject, decodeClientDataJSON } from '@simplewebauthn/server/helpers';

import { loadAccountStatus } from '@/lib/auth/account-status';
import {
  bridgeKeysFromEnv,
  needsNewerKey,
  newestKeyVersion,
  openBridgeSecret,
  sealBridgeSecret,
  type BridgeKeys,
} from '@/lib/auth/bridge-secret';
import { checkMfaCode } from '@/lib/auth/mfa-code-attempts';
import { accountIdHash } from '@/lib/auth/passkey-bridge';
import {
  carriesBridgeName,
  PASSKEY_BRIDGE_NAME_PREFIX,
  reservedFactorInFlight,
} from '@/lib/auth/passkey-bridge-name';
import { passkeyRelyingParty, type RelyingParty } from '@/lib/auth/passkey-relying-party';
import {
  authenticationResponseSchema,
  challengeIdSchema,
  cleanTransports,
  passkeyNameSchema,
  registrationResponseSchema,
} from '@/lib/auth/passkey-response-schema';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { totpCodeFromBase32 } from '@/lib/auth/totp';
import {
  readVerifiedSession,
  readVerifiedTokenClaims,
  type VerifiedSessionClaims,
} from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { emitAuthAudit, resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { defer } from '@/server/services/lib/defer';
import { broadcastEndedSessions, listMySessionIds } from '@/server/services/sessions';

import { recordSecurityEvent } from './events';
import {
  challengeAndVerifyAs,
  enrolTotpAs,
  readAccountAs,
  signOutAs,
  type AuthFactor,
  type RaisedSession,
} from './passkey-auth';
import { sendPasskeyAddedEmail, sendPasskeyRemovedEmail } from './passkey-emails';
import { LAST_METHOD_RETRY_WORDS, LAST_METHOD_WORDS, lastMethodVerdict } from './second-step-methods';
import {
  compareTimes,
  isReservedTotp,
  judgePasskeyAccount,
  PASSKEY_RAISE_EVENT,
  passkeyFactsOf,
  type AuthFactorFact,
} from './passkey-state';

import type { ActionErrorCode } from '@stockpilot/core';

/**
 * THE PASSKEY SERVER MODULE (plan section 2). A passkey is the member's
 * second step: after the password, the member's device proves it holds the
 * passkey, and this server answers a hidden TOTP factor (the "bridge", named
 * `sp-passkey-bridge-...`) at Supabase Auth with a code it computes from the
 * bridge's secret, which raises the SAME session to aal2.
 *
 * Server code only: `import 'server-only'`, never 'use server'. The actions
 * in server/actions/passkeys.ts call in here, each inside its own exported
 * function (server/security/events.guard.test.ts).
 *
 * THE GATES (stage 4, integrator decision A of 2026-11-21). Three levels,
 * read fresh on every start and every finish (rule 13); passkeyGate() and
 * passkeyUseGate() below:
 *   - ADD (a new passkey, the confirm_add proof, and Finish setup of a
 *     passkey that never served): a site (lib/auth/passkey-relying-party), a
 *     bridge key (PASSKEY_BRIDGE_KEY_V1/V2), and the database's
 *     `passkey_add_allowed` saying the kill switch is on, new passkeys are on
 *     and every organization of the member has passkeys on (`ok`, or
 *     `too_many` at ten).
 *   - USE (the second step, the step-up, and Finish setup that repairs an
 *     existing holder): the site, the key and the kill switch only. An
 *     organization switched off later, or new passkeys switched off, never
 *     locks an existing holder out of their own second step (answers Q1).
 *   - MANAGE (list, rename, remove one's own passkeys, on an aal2 session):
 *     a site only, whatever the switches say: removing only takes access
 *     away. With the kill switch off the panel lists them with Remove and one
 *     sentence, nothing else.
 *
 * THE RULES (plan 2.1; each is pinned by a test, passkeys.test.ts):
 *   1 no module-level client, token or session; 2 one verified token per
 *   action, kept in local variables, every Auth call as the member a plain
 *   fetch with it (passkey-auth.ts); 3 the account is the token's subject;
 *   4 the challenge is bound (session, purpose, browser cookie) and spent
 *   before any verification; 5 the credential is this account's, on this
 *   site, not removed, and the user handle (when sent) is this account's;
 *   6 the library decides with our settings only, and cross-origin and a
 *   changed backup-eligible flag are refused here; 7 the bridge is found by
 *   id from our table; 8 the raised session is the same session at aal2;
 *   9 the cookies are written once, after 8, and read back; 10 local checks
 *   before any Auth call; 11 the secret never leaves answerBridge; 12 the
 *   browser binding cookie; 13 switches read fresh; 14 no platform console
 *   account; 15 no disabled account; 16 the Auth fetch helper; 17 a session
 *   id is required; 18 the challenge's site must be ours; 19 an account with
 *   a verified factor adds only from an aal2 session; 20 the purpose is the
 *   action's own; 22 every failed use write refuses the sign-in; 23 one
 *   account's state by the database's rule (passkey-state.ts).
 *
 * WHAT IS NOT HERE (stage 5 and 6): the password reset's passkey answer, the
 * recovery-code wording, the platform console's switches.
 */

// ── Words (plain, short; plan section 4) ──────────────────────────────

export const PASSKEY_WORDS = {
  sessionEnded: 'Your sign-in ended. Sign in again.',
  disabled: 'This account is turned off. Contact your administrator.',
  unavailable: 'Passkeys are not available right now.',
  off: 'Passkeys are turned off right now. Use a recovery code to get back in, or try again later.',
  expired: 'That request expired. Try again.',
  notYours: 'This passkey is not one of yours. Try another one.',
  wrongSite: 'This passkey answer came from another site.',
  noUserVerification:
    'Your device did not check it was you. Try again and use your face, fingerprint or device PIN.',
  counterWentBack: "This passkey can't be used. Remove it in Settings and add it again.",
  refused: 'That passkey answer was not accepted. Try again.',
  formatRefused: 'This passkey was not accepted. Try a different passkey or device.',
  tryAgain: 'Try again.',
  tooMany: 'Too many tries. Wait a few minutes and try again.',
  busy: 'Busy right now. Wait a minute and try again.',
  cantUse: "Your passkey can't be used right now. Use a recovery code to get back in.",
  signInChanged: 'Your sign-in changed. Sign in again.',
  couldNotFinish: 'Could not finish just now. Try again.',
  noPasskey: 'This account has no passkey.',
  setupNotFinished:
    "Your passkey's setup isn't finished. Use your authenticator app now, then press Finish in Settings, Security.",
  console: 'Passkeys are not available for platform console accounts.',
  atLimit: 'You can add up to 10 passkeys.',
  removeAuthenticatorFirst: 'Remove an authenticator first.',
  stepUpFirst: "Confirm it's you first. Sign out and sign in again with your second step.",
  passwordWrong: 'That password is not right. Try again.',
  codeWrong: 'That code is not right. Try again.',
  proofNeeded: 'Confirm it is you first.',
  phoneConfirmation: 'Type I understand to add a passkey anyway.',
  addFailed: 'Could not add your passkey. Try again.',
  addNotFinished: 'Could not finish adding your passkey. Try again.',
  finishFirst: 'Finish setting up your passkey first. Press Finish next to it.',
  /**
   * Review 4 finding 4: a passkey whose setup is not finished, on an account
   * with no other second step (no verified factor, so the session cannot
   * reach aal2 to remove it). The two ways out, as they are.
   */
  onlyMethodUnfinished:
    "This passkey's setup isn't finished and it is your only second step, so it can't be removed yet. Add an authenticator app first, then remove it. Or use a recovery code, if you saved one: it removes every second step, passkeys included.",
  finishFirstOnlyMethod:
    "Finish setting up your passkey first. Press Finish next to it. If you can't, add an authenticator app first, then remove the passkey. Or use a recovery code, if you saved one: it removes every second step, passkeys included.",
  /** Decision B: the same words as an authenticator app's removal (second-step-methods.ts). */
  policyBlocksRemoval: LAST_METHOD_WORDS,
  removedFinishing: 'Removed. Finishing in the background.',
  alreadyRemoved: 'This passkey is already removed.',
  nameInvalid: "Use letters, numbers, spaces and ( ) + ' _ - only.",
} as const;

/** The purposes of a challenge (0475's check). Never read from a browser (rule 20). */
export type PasskeyPurpose =
  'second_step' | 'password_reset' | 'confirm_add' | 'register' | 'finish_setup';

export type PasskeyFailure = { ok: false; code: ActionErrorCode; message: string; reason?: string };
type Result<T> = ({ ok: true } & T) | PasskeyFailure;

const fail = (code: ActionErrorCode, message: string, reason?: string): PasskeyFailure => ({
  ok: false,
  code,
  message,
  ...(reason ? { reason } : {}),
});

/** The algorithms we accept: Ed25519, P-256, RSA (never the library's ML-DSA first; review 9.1). */
export const PASSKEY_ALGORITHMS = [-8, -7, -257];
/** How long a device prompt may stay open (the challenge itself lives 2 minutes, 0475). */
const PROMPT_TIMEOUT_MS = 120_000;
/** A bridge factor's name: the reserved prefix and 12 random hex characters. */
const bridgeFactorName = () => `${PASSKEY_BRIDGE_NAME_PREFIX}${randomBytes(6).toString('hex')}`;

// ── Limits (plan 2.8; every key on server/security/limiter-events.ts) ──

const MIN = 60_000;
async function allowStart(userId: string, ip: string): Promise<boolean> {
  const a = await checkRateLimit(`passkey-start:${userId}:${ip}`, 20, 15 * MIN, 'closed');
  if (!a.allowed) return false;
  const b = await checkRateLimit(`passkey-start-account:${userId}`, 60, 60 * MIN, 'closed');
  return b.allowed;
}
/**
 * Finishes are limited per account and address (review 4 finding 11): 10 in
 * 15 minutes for each address an account finishes from.
 */
async function allowFinish(userId: string, ip: string): Promise<boolean> {
  const a = await checkRateLimit(`passkey-finish:${userId}:${ip}`, 10, 15 * MIN, 'closed');
  return a.allowed;
}
async function allowRegister(userId: string): Promise<boolean> {
  return (await checkRateLimit(`passkey-register:${userId}`, 5, 15 * MIN, 'closed')).allowed;
}
async function allowRemove(userId: string): Promise<boolean> {
  return (await checkRateLimit(`passkey-remove:${userId}`, 10, 15 * MIN, 'closed')).allowed;
}

// ── Security events (plan 2.8; organization looked up after the response) ──

type PasskeyEventReason =
  'passkey_refused' | 'passkey_wrong_site' | 'passkey_counter_went_back' | 'passkey_checks_paused';

async function recordPasskeyEvent(reason: PasskeyEventReason, userId: string): Promise<void> {
  let captured: Awaited<ReturnType<typeof headers>> | null = null;
  try {
    captured = await headers();
  } catch {
    captured = null;
  }
  defer(async () => {
    const { organizationId } = await resolveDefaultOrgAndRole(userId);
    await recordSecurityEvent(
      {
        category: reason === 'passkey_wrong_site' ? 'phishing' : 'password_guessing',
        outcome: reason === 'passkey_counter_went_back' ? 'flagged' : 'blocked',
        reason,
        source: 'web',
        organizationId,
      },
      captured,
    );
  });
}

/** An error report about one account: a hash of its id, never the id. */
function reportPasskeys(
  tag: string,
  level: 'warning' | 'error',
  userId: string,
  extra: Record<string, unknown> = {},
) {
  void reportError(new Error(`Passkeys: ${tag}`), {
    tag: `passkeys.${tag}`,
    level,
    extra: { userIdHash: accountIdHash(userId), ...extra },
  });
}

// ── The gates (integrator decision A) ──────────────────────────────────

export type PasskeyGateClosed =
  | 'no_site'
  | 'no_key'
  | 'kill_switch_off'
  | 'adds_off'
  | 'organization_off'
  | 'no_membership'
  | 'disabled'
  | 'no_profile'
  | 'unreadable';

export type PasskeyGate =
  | {
      open: true;
      rp: RelyingParty;
      keys: BridgeKeys;
      atLimit: boolean;
      /** The ADD level holds too (every condition); false: why not. */
      addOpen: boolean;
      addWhy: PasskeyGateClosed | null;
    }
  | { open: false; why: PasskeyGateClosed };

/**
 * `passkey_add_allowed`'s words, in its own order (0475): no_profile,
 * disabled, kill_switch_off, adds_off, no_membership, organization_off,
 * too_many, ok. Every word after kill_switch_off says the kill switch is on.
 */
const USE_CLOSED_WORDS = new Set<PasskeyGateClosed>(['kill_switch_off', 'disabled', 'no_profile']);
const ADD_CLOSED_WORDS = new Set<PasskeyGateClosed>(['adds_off', 'no_membership', 'organization_off']);

type GateRead =
  | { open: false; why: PasskeyGateClosed }
  | { open: true; rp: RelyingParty; keys: BridgeKeys; word: 'ok' | 'too_many' | PasskeyGateClosed };

/**
 * One read of the gate for `userId`: a site, a key, then the database's word
 * (read fresh). With no site or no key the database is not asked. A failed
 * read, or a word this build does not know, is closed at every level.
 */
async function readGate(userId: string): Promise<GateRead> {
  const rp = passkeyRelyingParty();
  if (!rp) return { open: false, why: 'no_site' };
  const keys = bridgeKeysFromEnv();
  if (newestKeyVersion(keys) === null) return { open: false, why: 'no_key' };
  let word: unknown;
  try {
    const { data, error } = await createAdminClient().rpc('passkey_add_allowed', {
      p_user_id: userId,
    });
    if (error) return { open: false, why: 'unreadable' };
    word = data;
  } catch {
    return { open: false, why: 'unreadable' };
  }
  if (typeof word !== 'string') return { open: false, why: 'unreadable' };
  if (USE_CLOSED_WORDS.has(word as PasskeyGateClosed))
    return { open: false, why: word as PasskeyGateClosed };
  if (word === 'ok' || word === 'too_many' || ADD_CLOSED_WORDS.has(word as PasskeyGateClosed)) {
    return { open: true, rp, keys, word: word as 'ok' | 'too_many' | PasskeyGateClosed };
  }
  return { open: false, why: 'unreadable' };
}

function gateForUse(r: GateRead): PasskeyGate {
  if (!r.open) return r;
  const addOpen = r.word === 'ok' || r.word === 'too_many';
  return {
    open: true,
    rp: r.rp,
    keys: r.keys,
    atLimit: r.word === 'too_many',
    addOpen,
    addWhy: addOpen ? null : (r.word as PasskeyGateClosed),
  };
}

function gateForAdd(r: GateRead): PasskeyGate {
  const use = gateForUse(r);
  if (!use.open) return use;
  if (!use.addOpen) return { open: false, why: use.addWhy ?? 'unreadable' };
  return use;
}

/**
 * The ADD level for `userId` now: a site, a key, and the database's word
 * (kill switch on, new passkeys on, every organization of the member on;
 * `passkey_add_allowed`, read fresh). A failed read is closed.
 */
export async function passkeyGate(userId: string): Promise<PasskeyGate> {
  return gateForAdd(await readGate(userId));
}

/**
 * The USE level for `userId` now: a site, a key and the kill switch on. The
 * organization switches and "new passkeys" do not close it (they stop NEW
 * passkeys only); `addOpen` says whether the ADD level holds as well.
 */
export async function passkeyUseGate(userId: string): Promise<PasskeyGate> {
  return gateForUse(await readGate(userId));
}

// ── The session, read once per action (rules 2, 3, 17) ─────────────────

type CookieClient = Awaited<ReturnType<typeof createClient>>;

interface Held {
  token: string;
  claims: VerifiedSessionClaims;
  supabase: CookieClient;
}

async function holdSession(): Promise<Held | null> {
  const supabase = await createClient();
  const session = await readVerifiedSession(supabase);
  if (!session) return null;
  return { token: session.token, claims: session.claims, supabase };
}

async function clientIp(): Promise<string> {
  try {
    return clientIpFromHeaders(await headers());
  } catch {
    return 'unknown';
  }
}

type Step = 'start' | 'finish' | 'register' | 'remove' | 'manage';
type OpenGate = Extract<PasskeyGate, { open: true }>;

/** A closed gate's refusal: the kill switch has its own words. */
function gateRefusal(why: PasskeyGateClosed): PasskeyFailure {
  return fail(
    'forbidden',
    why === 'kill_switch_off' ? PASSKEY_WORDS.off : PASSKEY_WORDS.unavailable,
    `gate_${why}`,
  );
}

/** The session part of every prologue: the verified session, a session id, the account not disabled (rule 15). */
async function heldActive(): Promise<Result<{ held: Held }>> {
  const held = await holdSession();
  if (!held) return fail('unauthenticated', PASSKEY_WORDS.sessionEnded);
  if (!held.claims.sessionId)
    return fail('unauthenticated', PASSKEY_WORDS.sessionEnded, 'no_session_id');
  // Rule 15: a disabled account, before any limiter counts; a status that
  // cannot be read is closed.
  const status = await loadAccountStatus(held.supabase, held.claims.userId);
  if (status === 'disabled') return fail('forbidden', PASSKEY_WORDS.disabled, 'disabled');
  if (status !== 'active')
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'status_unreadable');
  return { ok: true, held };
}

/** Our limiter for one step; a refusal is a security event (passkey_checks_paused). */
async function limited(step: Step, userId: string): Promise<PasskeyFailure | null> {
  const ip = await clientIp();
  const allowed =
    step === 'start'
      ? await allowStart(userId, ip)
      : step === 'finish'
        ? await allowFinish(userId, ip)
        : step === 'register'
          ? await allowRegister(userId)
          : step === 'remove'
            ? await allowRemove(userId)
            : true;
  if (allowed) return null;
  await recordPasskeyEvent('passkey_checks_paused', userId);
  return fail('rate_limited', PASSKEY_WORDS.tooMany, 'limited');
}

/**
 * The common prologue (plan 2.6 P): the session (heldActive), the gate at
 * `level`, then our limiter.
 */
async function prologue(
  step: Step,
  level: 'add' | 'use',
): Promise<Result<{ held: Held; gate: OpenGate }>> {
  const h = await heldActive();
  if (!h.ok) return h;
  const { held } = h;
  const read = await readGate(held.claims.userId);
  const gate = level === 'add' ? gateForAdd(read) : gateForUse(read);
  if (!gate.open) return gateRefusal(gate.why);
  const refused = await limited(step, held.claims.userId);
  if (refused) return refused;
  return { ok: true, held, gate };
}

/**
 * The MANAGE prologue (list, rename, remove one's own passkeys): the session,
 * a site, our limiter. No key and no switch: removing only takes access away,
 * so a member whose organization or the platform switched passkeys off can
 * still remove theirs (decision A).
 */
async function managePrologue(
  step: 'remove' | 'manage',
): Promise<Result<{ held: Held; rp: RelyingParty }>> {
  const h = await heldActive();
  if (!h.ok) return h;
  const rp = passkeyRelyingParty();
  if (!rp) return gateRefusal('no_site');
  const refused = await limited(step, h.held.claims.userId);
  if (refused) return refused;
  return { ok: true, held: h.held, rp };
}

// ── The browser binding cookie (rule 12) ───────────────────────────────

const BIND_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const isLocal = (rp: RelyingParty) => rp.rpId === 'localhost';
export const bindCookieName = (rp: RelyingParty) =>
  isLocal(rp) ? 'sp_pk_bind' : '__Host-sp_pk_bind';

async function setBinding(rp: RelyingParty): Promise<string> {
  const value = randomBytes(32).toString('base64url');
  (await cookies()).set(bindCookieName(rp), value, {
    httpOnly: true,
    secure: !isLocal(rp),
    sameSite: 'strict',
    path: '/',
    maxAge: 180,
  });
  return sha256hex(value);
}

/** The binding's hash, and the cookie cleared; null without a well-formed cookie. */
async function takeBinding(rp: RelyingParty): Promise<string | null> {
  const store = await cookies();
  const value = store.get(bindCookieName(rp))?.value;
  store.set(bindCookieName(rp), '', {
    httpOnly: true,
    secure: !isLocal(rp),
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return value && BIND_VALUE_RE.test(value) ? sha256hex(value) : null;
}

// ── Records (service role, per call; rule 1) ───────────────────────────

type Admin = ReturnType<typeof createAdminClient>;

export interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number | string;
  transports: string[] | null;
  backup_eligible: boolean;
  backed_up: boolean;
  rp_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  removed_at: string | null;
}

interface BridgeRow {
  factor_id: string;
  secret_ciphertext: string;
  key_version: number;
  created_at: string | null;
}

const ROW_COLUMNS =
  'id, credential_id, public_key, counter, transports, backup_eligible, backed_up, rp_id, name, created_at, last_used_at, removed_at';

/**
 * More than an account can hold active (passkey_add_allowed answers too_many
 * at 10); a full page of active rows is not believed (closed).
 */
const ACTIVE_ROWS_READ = 25;

/**
 * The rows that decide `userId`'s state for this site (review 4 finding 5):
 * the ACTIVE rows of this site, read on their own (newest first), so no
 * amount of removed history can cut one off; then one active row of another
 * site, if any, and the newest removed row, if any, which is all the state
 * needs of them (passkey-state: whether there are any, and the newest
 * removal). Removed rows live 90 days and nothing caps their number. null
 * when any read fails, or when the active page is full.
 */
async function readRows(admin: Admin, userId: string, rpId: string): Promise<PasskeyRow[] | null> {
  try {
    const [active, otherSite, newestRemoved] = await Promise.all([
      admin
        .from('member_passkeys')
        .select(ROW_COLUMNS)
        .eq('user_id', userId)
        .eq('rp_id', rpId)
        .is('removed_at', null)
        .order('created_at', { ascending: false })
        .limit(ACTIVE_ROWS_READ),
      admin
        .from('member_passkeys')
        .select(ROW_COLUMNS)
        .eq('user_id', userId)
        .neq('rp_id', rpId)
        .is('removed_at', null)
        .limit(1),
      admin
        .from('member_passkeys')
        .select(ROW_COLUMNS)
        .eq('user_id', userId)
        .not('removed_at', 'is', null)
        .order('removed_at', { ascending: false })
        .limit(1),
    ]);
    const parts = [active, otherSite, newestRemoved];
    if (parts.some((p) => p.error || !Array.isArray(p.data))) return null;
    if ((active.data as unknown[]).length >= ACTIVE_ROWS_READ) return null;
    return parts.flatMap((p) => p.data as PasskeyRow[]);
  } catch {
    return null;
  }
}

async function readBridgeRow(
  admin: Admin,
  userId: string,
): Promise<BridgeRow | null | 'unreadable'> {
  try {
    const { data, error } = await admin
      .from('passkey_bridges')
      .select('factor_id, secret_ciphertext, key_version, created_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return 'unreadable';
    if (data === null) return null;
    const b = data as Partial<BridgeRow>;
    if (
      typeof b.factor_id !== 'string' ||
      typeof b.secret_ciphertext !== 'string' ||
      typeof b.key_version !== 'number'
    ) {
      return 'unreadable';
    }
    return {
      factor_id: b.factor_id,
      secret_ciphertext: b.secret_ciphertext,
      key_version: b.key_version,
      created_at: b.created_at ?? null,
    };
  } catch {
    return 'unreadable';
  }
}

/** A copy of `b` on its own ArrayBuffer (the library's byte type). */
function ownBytes(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

/** A bytea as PostgREST sends it (`\x` then hex), as bytes. */
function bytesOfBytea(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || !/^\\x(?:[0-9a-fA-F]{2})+$/.test(text)) return null;
  return ownBytes(Buffer.from(text.slice(2), 'hex'));
}

// ── One account's state (rule 23) ──────────────────────────────────────

/** What the server knows of one account for a passkey decision. */
export interface AccountPicture {
  email: string | null;
  factors: AuthFactor[];
  rows: PasskeyRow[];
  bridge: BridgeRow | null;
  state: ReturnType<typeof judgePasskeyAccount>;
  facts: ReturnType<typeof passkeyFactsOf>;
  /** Active rows of this site. */
  active: PasskeyRow[];
  /** Verified TOTP factors that are not the recorded bridge (the member's apps). */
  apps: AuthFactor[];
}

async function readPicture(
  admin: Admin,
  held: Held,
  rp: RelyingParty,
): Promise<Result<{ picture: AccountPicture }>> {
  const userId = held.claims.userId;
  const [rows, bridge, account] = await Promise.all([
    readRows(admin, userId, rp.rpId),
    readBridgeRow(admin, userId),
    readAccountAs(held.token),
  ]);
  if (!account) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'account_unreadable');
  // Rule 3: the account Auth answers for this token is the token's subject.
  if (account.id !== userId)
    return fail('unauthenticated', PASSKEY_WORDS.sessionEnded, 'account_changed');
  if (rows === null || bridge === 'unreadable')
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'records_unreadable');
  const apps = account.factors.filter(
    (f) => f.factor_type === 'totp' && f.status === 'verified' && f.id !== bridge?.factor_id,
  );
  return {
    ok: true,
    picture: {
      email: account.email,
      factors: account.factors,
      ...judged(rows, bridge, account.factors, rp),
      apps,
    },
  };
}

/** The judged part of a picture: the account's rows, bridge row and factors, by rule 23. */
type Judged = Pick<AccountPicture, 'rows' | 'bridge' | 'state' | 'facts' | 'active'>;

function judged(
  rows: PasskeyRow[],
  bridge: BridgeRow | null,
  factors: ReadonlyArray<AuthFactorFact>,
  rp: RelyingParty,
): Judged {
  const facts = passkeyFactsOf(rows, bridge?.factor_id ?? null, factors, rp.rpId);
  return {
    rows,
    bridge,
    state: judgePasskeyAccount(facts),
    facts,
    active: rows.filter((r) => r.removed_at === null && r.rp_id === rp.rpId),
  };
}

/** A healthy state, where the passkey answers: S6, plus S15 and S3 beside a healthy bridge. */
function bridgeServes(p: Judged): boolean {
  if (p.active.length === 0 || !p.bridge || p.facts.bridgeStatus !== 'verified') return false;
  if (p.state === 'healthy' || p.state === 'unverified_reserved_factor') return true;
  // S15: a second verified reserved-name factor beside a VERIFIED bridge.
  return p.state === 'reserved_factor_without_row' && p.facts.bridgeStatus === 'verified';
}

/**
 * Review 4 finding 4: a setup not finished on an account with no verified
 * factor at all, so no session of it can reach aal2 to remove the passkey.
 */
function onlyMethodUnfinished(p: AccountPicture): boolean {
  return setupUnfinished(p) && !p.factors.some((f) => f.status === 'verified');
}

/**
 * The states that fail closed and wait for the member or the operator (10.1,
 * the upkeep's CLOSED_STATES): S8, S12 and S14 (S15 serves), S17.
 */
const FAIL_CLOSED_STATES = new Set<string>([
  'bridge_without_passkey',
  'reserved_factor_without_row',
  'bridge_newer_than_removal',
]);

/**
 * Why a picture fails closed, or null: 'bridge_unopenable' (S9: the bridge
 * would serve but the keys we hold do not open its secret), else the state
 * word of a fail-closed state that does not serve.
 */
function failClosedFault(picture: Judged, userId: string, keys: BridgeKeys): string | null {
  if (bridgeServes(picture)) return opens(picture, userId, keys) ? null : 'bridge_unopenable';
  return FAIL_CLOSED_STATES.has(picture.state) ? picture.state : null;
}

/** Reported once an hour for everyone as `passkeys.key_fault` (review B6, corrected). */
async function reportKeyFault(userId: string, fault: string, site: string): Promise<void> {
  const all = await checkRateLimit(`passkeys-key-report:${fault}`, 1, 60 * MIN, 'closed');
  if (all.allowed) reportPasskeys('key_fault', 'error', userId, { fault, site });
}

/**
 * Review 4 finding 1: a fail-closed state or a key fault the second-step page
 * meets is reported from the page's own read (stepOf), since the page then
 * offers no passkey and no button press can report it; a start reports what
 * it meets the same way (review B6). Error level, the account as a hash of
 * its id. The limiter is closed: one that cannot count reports nothing
 * (lib/rate-limit logs it). The member's answer and words do not change.
 * Never throws.
 *   - A state, and a secret the keys do not open (S9, which can be one
 *     account's row: swapped, damaged, or sealed with a key version we do
 *     not hold): at most once an hour per account and fault, the page and
 *     the start sharing that pace.
 *   - The key MISSING is one fault for everyone: `passkeys.key_fault`, once
 *     an hour, and no report per account.
 *   - A secret that does not open also counts toward that roll-up, once an
 *     hour for everyone, asked after the account's own limiter.
 */
async function reportStepFault(
  userId: string,
  fault: string,
  site: 'second_step' | 'start' = 'second_step',
): Promise<void> {
  try {
    if (fault === 'no_key') {
      await reportKeyFault(userId, fault, site);
      return;
    }
    const one = await checkRateLimit(
      `passkeys-step-report:${userId}:${fault}`,
      1,
      60 * MIN,
      'closed',
    );
    if (one.allowed) reportPasskeys(fault, 'error', userId, { site });
    if (fault === 'bridge_unopenable') await reportKeyFault(userId, fault, site);
  } catch {
    // A report never changes the page.
  }
}

/** Setup not finished: S2 (no row), S4 (factor unverified), S10 (factor gone). */
function setupUnfinished(p: AccountPicture): boolean {
  return (
    p.active.length > 0 &&
    (p.state === 'no_bridge' ||
      p.state === 'bridge_factor_missing' ||
      p.state === 'bridge_factor_unverified')
  );
}

// ── Challenges (rules 4, 17, 18, 20) ───────────────────────────────────

/** 32 random bytes; the library is handed the bytes, so options.challenge is this base64url. */
function newChallenge(): { bytes: Uint8Array<ArrayBuffer>; text: string } {
  const bytes = ownBytes(randomBytes(32));
  return { bytes, text: Buffer.from(bytes).toString('base64url') };
}

async function issueChallenge(
  admin: Admin,
  held: Held,
  purpose: PasskeyPurpose,
  rp: RelyingParty,
  challenge: string,
): Promise<Result<{ challengeId: string }>> {
  const bindingHash = await setBinding(rp);
  const { data, error } = await admin.rpc('issue_passkey_challenge', {
    p_user_id: held.claims.userId,
    p_session_id: held.claims.sessionId,
    p_purpose: purpose,
    p_challenge: challenge,
    p_binding_hash: bindingHash,
    p_rp_id: rp.rpId,
  });
  if (error) {
    const code = (error as { code?: unknown }).code;
    if (code === '54000') return fail('rate_limited', PASSKEY_WORDS.tooMany, 'challenge_cap');
    if (code === '42501') return fail('forbidden', PASSKEY_WORDS.off, 'kill_switch_off');
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'challenge_not_issued');
  }
  if (typeof data !== 'string')
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'challenge_not_issued');
  return { ok: true, challengeId: data };
}

/**
 * Spends the challenge (rule 4): bound to this account, this session, this
 * PURPOSE (the caller's constant, rule 20) and this browser's cookie. A
 * challenge of another purpose, session or browser is "expired". The site the
 * row names must be ours (rule 18).
 */
async function takeChallenge(
  admin: Admin,
  held: Held,
  purpose: PasskeyPurpose,
  rp: RelyingParty,
  challengeId: string,
): Promise<Result<{ challenge: string }>> {
  const bindingHash = await takeBinding(rp);
  if (!bindingHash) return fail('validation_error', PASSKEY_WORDS.expired, 'no_binding');
  const { data, error } = await admin.rpc('take_passkey_challenge', {
    p_id: challengeId,
    p_user_id: held.claims.userId,
    p_session_id: held.claims.sessionId,
    p_purpose: purpose,
    p_binding_hash: bindingHash,
  });
  if (error) {
    if ((error as { code?: unknown }).code === '42501')
      return fail('forbidden', PASSKEY_WORDS.off, 'kill_switch_off');
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'challenge_unreadable');
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object')
    return fail('validation_error', PASSKEY_WORDS.expired, 'challenge_not_found');
  const { challenge, rp_id } = row as { challenge?: unknown; rp_id?: unknown };
  if (typeof challenge !== 'string')
    return fail('validation_error', PASSKEY_WORDS.expired, 'challenge_not_found');
  if (rp_id !== rp.rpId)
    return fail('validation_error', PASSKEY_WORDS.refused, 'challenge_other_site');
  return { ok: true, challenge };
}

// ── Library verdicts (rule 6) ──────────────────────────────────────────

type Verdict = 'wrong_site' | 'no_user_verification' | 'counter_went_back' | 'refused';

/** The library's own error, classified by its text (never shown, never logged). */
function verdictOfLibraryError(e: unknown): Verdict {
  const text = e instanceof Error ? e.message : '';
  if (/origin|RP ID|rpIdHash/i.test(text)) return 'wrong_site';
  if (/User verification (was )?required/i.test(text)) return 'no_user_verification';
  if (/counter value .* was lower/i.test(text)) return 'counter_went_back';
  return 'refused';
}

async function refuseByVerdict(verdict: Verdict, userId: string): Promise<PasskeyFailure> {
  if (verdict === 'wrong_site') {
    await recordPasskeyEvent('passkey_wrong_site', userId);
    return fail('validation_error', PASSKEY_WORDS.wrongSite, 'wrong_site');
  }
  if (verdict === 'counter_went_back') {
    await recordPasskeyEvent('passkey_counter_went_back', userId);
    return fail('validation_error', PASSKEY_WORDS.counterWentBack, 'counter_went_back');
  }
  await recordPasskeyEvent('passkey_refused', userId);
  return verdict === 'no_user_verification'
    ? fail('validation_error', PASSKEY_WORDS.noUserVerification, 'no_user_verification')
    : fail('validation_error', PASSKEY_WORDS.refused, 'refused');
}

/** Rule 6: a cross-origin answer is refused by us (the library reads it only for sign-in, and only with a top origin). */
function crossOriginOf(clientDataJSON: string): boolean | null {
  try {
    const decoded = decodeClientDataJSON(clientDataJSON) as { crossOrigin?: unknown };
    return decoded.crossOrigin === true;
  } catch {
    return null;
  }
}

/**
 * Review 4 finding 11: `attestationType: 'none'` asks the browser for no
 * attestation, but the answer is whatever the browser (or anyone calling the
 * action) sends, and the library verifies the format it carries. For apple,
 * android-key and android-safetynet it holds built-in root certificates; a
 * statement whose chain reaches one makes it fetch the revocation lists named
 * in the certificates, with no time limit of its own. Only two formats are
 * verified with no certificate path at all: 'none' (an empty statement) and
 * 'packed' self-attestation (signed by the new key, no x5c). Anything else is
 * refused here, before the library, so no registration can make the server
 * fetch anything. A browser asked for 'none' sends 'none' (it may keep a
 * packed self-attestation, which carries nothing identifying).
 *
 * null when the answer is one of those two; otherwise the refused format as
 * a word from a fixed list (review B5), never the caller's own text.
 */
function refusedAttestationFormat(attestationObject: string): RefusedFormat | null {
  try {
    const decoded = decodeAttestationObject(ownBytes(Buffer.from(attestationObject, 'base64url')));
    const fmt = decoded.get('fmt');
    const statement = decoded.get('attStmt');
    if (!(statement instanceof Map)) return 'other';
    if (fmt === 'none') return statement.size === 0 ? null : 'other';
    if (fmt === 'packed') {
      if (statement.has('x5c')) return 'packed-x5c';
      return statement.has('ecdaaKeyId') ? 'other' : null;
    }
    const named = REFUSED_FORMATS.find((f) => f === fmt);
    return named ?? 'other';
  } catch {
    return 'other';
  }
}

/** The formats a refusal report may name (review B5); anything else is 'other'. */
const REFUSED_FORMATS = ['fido-u2f', 'tpm', 'android-key', 'android-safetynet', 'apple'] as const;
type RefusedFormat = (typeof REFUSED_FORMATS)[number] | 'packed-x5c' | 'other';

/**
 * Review B5: a refused format is seen, so a device or password manager that
 * sends one is found: a warning with the format's word and the account as a
 * hash of its id, at most once an hour per format (closed limiter). Never
 * throws.
 */
async function reportRefusedFormat(userId: string, format: RefusedFormat): Promise<void> {
  try {
    const paced = await checkRateLimit(`passkey-format-report:${format}`, 1, 60 * MIN, 'closed');
    if (paced.allowed) reportPasskeys('attestation_refused', 'warning', userId, { format });
  } catch {
    // A report never changes the answer.
  }
}

/** The user handle this account's passkeys carry: its id as UTF-8, base64url (review K). */
const userHandleOf = (userId: string) => Buffer.from(userId, 'utf8').toString('base64url');

/**
 * Verifies a sign-in style answer for `purpose` (rules 4, 5, 6, 22): the
 * challenge spent first, the credential looked up, the library's verdict,
 * then the use write. All local: no Auth call (rule 10).
 */
async function verifyAssertion(
  admin: Admin,
  held: Held,
  rp: RelyingParty,
  purpose: PasskeyPurpose,
  input: { challengeId: unknown; response: unknown },
): Promise<Result<{ row: PasskeyRow; backedUp: boolean }>> {
  const userId = held.claims.userId;
  const challengeId = challengeIdSchema.safeParse(input.challengeId);
  const response = authenticationResponseSchema.safeParse(input.response);
  if (!challengeId.success || !response.success)
    return fail('validation_error', PASSKEY_WORDS.refused, 'shape');
  const taken = await takeChallenge(admin, held, purpose, rp, challengeId.data);
  if (!taken.ok) return taken;

  const answer = response.data;
  if (answer.id !== answer.rawId) return refuseByVerdict('refused', userId);
  const rows = await readRows(admin, userId, rp.rpId);
  if (rows === null)
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'records_unreadable');
  const row = rows.find(
    (r) => r.credential_id === answer.rawId && r.removed_at === null && r.rp_id === rp.rpId,
  );
  if (!row) {
    await recordPasskeyEvent('passkey_refused', userId);
    return fail('validation_error', PASSKEY_WORDS.notYours, 'not_yours');
  }
  if (
    answer.response.userHandle !== undefined &&
    answer.response.userHandle !== userHandleOf(userId)
  ) {
    await recordPasskeyEvent('passkey_refused', userId);
    return fail('validation_error', PASSKEY_WORDS.notYours, 'user_handle');
  }
  const crossOrigin = crossOriginOf(answer.response.clientDataJSON);
  if (crossOrigin === null) return refuseByVerdict('refused', userId);
  if (crossOrigin) return refuseByVerdict('wrong_site', userId);
  const publicKey = bytesOfBytea(row.public_key);
  if (!publicKey) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'key_unreadable');

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: answer,
      expectedChallenge: taken.challenge,
      expectedOrigin: [...rp.origins],
      expectedRPID: rp.rpId,
      credential: {
        id: row.credential_id,
        publicKey,
        counter: Number(row.counter),
        transports: (row.transports ?? []) as never,
      },
      requireUserVerification: true,
    });
  } catch (e) {
    return refuseByVerdict(verdictOfLibraryError(e), userId);
  }
  const info = verification.authenticationInfo;
  if (verification.verified !== true || info.userVerified !== true) {
    return refuseByVerdict('no_user_verification', userId);
  }
  // Rule 6 (review 9.3): the backup-eligible flag never changes for a credential.
  if ((info.credentialDeviceType === 'multiDevice') !== row.backup_eligible) {
    return refuseByVerdict('refused', userId);
  }

  // Rule 22: the use write stores the counter; it is part of the answer.
  const nowIso = new Date().toISOString();
  const lastUsedAt = (compareTimes(nowIso, row.created_at) ?? 1) >= 0 ? nowIso : row.created_at;
  let wrote = false;
  try {
    const { data, error } = await admin
      .from('member_passkeys')
      .update({
        counter: info.newCounter,
        last_used_at: lastUsedAt,
        backed_up: info.credentialBackedUp,
      })
      .eq('id', row.id)
      .eq('user_id', userId)
      .eq('counter', row.counter)
      .is('removed_at', null)
      .select('id');
    wrote = !error && Array.isArray(data) && data.length === 1;
  } catch {
    wrote = false;
  }
  if (!wrote) return fail('internal_error', PASSKEY_WORDS.tryAgain, 'use_write');
  return { ok: true, row, backedUp: info.credentialBackedUp };
}

// ── Answering the bridge (plan 2.5; rules 7, 8, 9, 11) ─────────────────

/**
 * Computes the bridge's code and answers it AS the member (challenge, then
 * verify, in this one invocation). The secret and the code stay in this
 * function. Auth's answer is mapped by its code only.
 */
async function answerBridge(
  token: string,
  userId: string,
  factorId: string,
  secret: string,
): Promise<Result<{ session: RaisedSession }>> {
  let ipRetried = false;
  for (let step = 0; step < 2; step += 1) {
    const code = totpCodeFromBase32(secret, Date.now(), step);
    if (!code) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'secret_unusable');
    const answer = await challengeAndVerifyAs(token, factorId, code);
    if (answer.ok) return { ok: true, session: answer.session };
    switch (answer.code) {
      case 'mfa_verification_failed':
        // Should never happen; one retry with the next step's code (spike Q7).
        if (step === 0) continue;
        reportPasskeys('bridge_refused', 'error', userId, { step: answer.step });
        return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'bridge_refused');
      case 'mfa_ip_address_mismatch':
        if (!ipRetried) {
          ipRetried = true;
          step -= 1;
          continue;
        }
        return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'ip_mismatch');
      case 'session_not_found':
        return fail('unauthenticated', PASSKEY_WORDS.signInChanged, 'session_not_found');
      case 'over_request_rate_limit':
        return fail('rate_limited', PASSKEY_WORDS.busy, 'auth_limited');
      default:
        reportPasskeys('bridge_unclassified', 'warning', userId, {
          code: answer.code,
          step: answer.step,
        });
        return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'bridge_unclassified');
    }
  }
  return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'bridge_refused');
}

/**
 * Rules 8 and 9: the returned token must be THIS session's, at aal2, or it is
 * signed out and refused (no cookie written). Then the cookies are written
 * once with the returned tokens, and read back.
 */
async function adoptRaisedSession(held: Held, raised: RaisedSession): Promise<Result<object>> {
  const { userId, sessionId } = held.claims;
  const claims = await readVerifiedTokenClaims(held.supabase, raised.access_token);
  if (
    !claims ||
    claims.userId !== userId ||
    claims.sessionId !== sessionId ||
    claims.aal !== 'aal2'
  ) {
    await signOutAs(raised.access_token, 'local');
    return fail('unauthenticated', PASSKEY_WORDS.signInChanged, 'raised_other_session');
  }
  const { error } = await held.supabase.auth.setSession({
    access_token: raised.access_token,
    refresh_token: raised.refresh_token,
  });
  if (error) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'cookie_not_written');
  const after = await readVerifiedSession(held.supabase);
  if (
    !after ||
    after.claims.userId !== userId ||
    after.claims.sessionId !== sessionId ||
    after.claims.aal !== 'aal2'
  ) {
    try {
      await held.supabase.auth.signOut({ scope: 'local' });
    } catch {
      // The refusal below stands either way.
    }
    return fail('unauthenticated', PASSKEY_WORDS.sessionEnded, 'account_changed_after');
  }
  return { ok: true };
}

/** The account's audit row of a passkey event (plan 2.8; never the credential id, key, counter, code or secret). */
async function auditPasskey(
  event: 'passkey.added' | 'passkey.removed' | 'passkey.used' | 'passkey.bridge_repaired',
  userId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const { organizationId } = await resolveDefaultOrgAndRole(userId);
  await emitAuthAudit({ event, userId, organizationId, extra });
}

/**
 * The row of one bridge raise, written before the bridge is answered and
 * REQUIRED (plan 10.4, integrator decision 2026-11-21): it carries the
 * session id and a random id made for this raise, so the hourly detector
 * (server/security/passkey-detector.ts) can match each raise to its own row.
 * When the row is not written on the first try the ceremony refuses and the
 * bridge is not answered: a raise without its row never happens on our side,
 * so a raise without a row is not ours.
 */
async function recordRaise(
  userId: string,
  sessionId: string | null,
  purpose: 'second_step' | 'add' | 'finish_setup',
): Promise<Result<{ raiseId: string }>> {
  // Rule 17 refuses a session without an id before here; the row needs one.
  if (!sessionId) return fail('unauthenticated', PASSKEY_WORDS.sessionEnded, 'no_session_id');
  const raiseId = randomUUID();
  let written = false;
  try {
    const { organizationId } = await resolveDefaultOrgAndRole(userId);
    written = await emitAuthAudit({
      event: PASSKEY_RAISE_EVENT,
      userId,
      organizationId,
      extra: { session_id: sessionId, raise_id: raiseId, purpose },
    });
  } catch {
    written = false;
  }
  if (!written) {
    reportPasskeys('raise_row_unwritten', 'error', userId, { purpose });
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'raise_row_unwritten');
  }
  return { ok: true, raiseId };
}

// ── A. B. The second step (sign-in page and step-up modal) ─────────────

export type SecondStepStart =
  { kind: 'options'; challengeId: string; optionsJSON: unknown } | { kind: 'removal_finished' };

/** What a ceremony start has read: the session, the open gate, the account. */
type CeremonyStart = { held: Held; gate: OpenGate; admin: Admin; picture: AccountPicture };

/**
 * The prologue and the account's picture for a ceremony start. Decision A:
 * the confirm_add proof belongs to adding; the second step and Finish setup
 * start at the USE level (Finish setup of a passkey that never served asks
 * the ADD level once the picture is read).
 */
async function readForStart(level: 'add' | 'use'): Promise<Result<CeremonyStart>> {
  const p = await prologue('start', level);
  if (!p.ok) return p;
  const admin = createAdminClient();
  const read = await readPicture(admin, p.held, p.gate.rp);
  if (!read.ok) return read;
  return { ok: true, held: p.held, gate: p.gate, admin, picture: read.picture };
}

/**
 * Starts a ceremony of `purpose` for a member whose passkey answers (S6).
 * It writes one challenge and nothing else: finishing a removal the member
 * started (S7, S13) is startSecondStep's alone (review 4 finding 3), so the
 * confirm_add and finish_setup starts cannot reach a delete.
 */
async function startCeremony(
  purpose: 'second_step' | 'confirm_add' | 'finish_setup',
  started: CeremonyStart,
): Promise<Result<{ start: SecondStepStart }>> {
  const { held, gate, admin, picture } = started;
  const userId = held.claims.userId;
  // Review 4 finding 1: a state that fails closed (or S9) is reported before
  // any answer, the "no passkey" one included (S8, S17 have no active row),
  // at the page's pace (review B6). A Finish setup start is the repair
  // itself and reports nothing here.
  const fault = purpose === 'finish_setup' ? null : failClosedFault(picture, userId, gate.keys);
  if (fault) await reportStepFault(userId, fault, 'start');
  if (picture.active.length === 0)
    return fail('validation_error', PASSKEY_WORDS.noPasskey, 'no_passkey');
  if (purpose === 'finish_setup') {
    if (
      !setupUnfinished(picture) &&
      !(bridgeServes(picture) && !opens(picture, userId, gate.keys))
    ) {
      return fail('validation_error', PASSKEY_WORDS.couldNotFinish, 'nothing_to_finish');
    }
    if (!existingHolder(picture, userId, gate.keys, (r) => r.last_used_at !== null) && !gate.addOpen)
      return gateRefusal(gate.addWhy ?? 'unreadable');
  } else if (!bridgeServes(picture)) {
    if (setupUnfinished(picture))
      return fail('validation_error', PASSKEY_WORDS.setupNotFinished, 'setup_unfinished');
    if (!fault) await reportStepFault(userId, picture.state, 'start');
    return fail('forbidden', PASSKEY_WORDS.cantUse, picture.state);
  } else if (!opens(picture, userId, gate.keys)) {
    return fail('forbidden', PASSKEY_WORDS.cantUse, 'bridge_unopenable');
  }

  const challenge = newChallenge();
  const optionsJSON = await generateAuthenticationOptions({
    rpID: gate.rp.rpId,
    challenge: challenge.bytes,
    userVerification: 'required',
    timeout: PROMPT_TIMEOUT_MS,
    allowCredentials: picture.active.map((r) => ({
      id: r.credential_id,
      transports: (r.transports ?? []) as never,
    })),
  });
  const issued = await issueChallenge(admin, held, purpose, gate.rp, challenge.text);
  if (!issued.ok) return issued;
  return { ok: true, start: { kind: 'options', challengeId: issued.challengeId, optionsJSON } };
}

/**
 * Decision A: Finish setup repairs an EXISTING holder at the USE level; for a
 * passkey that never served it completes an add and needs the ADD level. An
 * existing holder: the bridge serves but does not open with our keys (S9, a
 * repair), or an active passkey of this site was used before this ceremony
 * (`usedBefore`: a finish reads the row as it was before its own use).
 */
function existingHolder(
  picture: AccountPicture,
  userId: string,
  keys: BridgeKeys,
  usedBefore: (r: PasskeyRow) => boolean,
): boolean {
  if (bridgeServes(picture) && !opens(picture, userId, keys)) return true;
  return picture.active.some(usedBefore);
}

/**
 * The passkeys answer as the second step: the bridge serves (bridgeServes)
 * and its secret opens with the keys we hold. The second-step page's own
 * judgement (stepOf), and the last-method rule's (servingPasskeyIds,
 * removePasskey; decision B, correction 1).
 */
function servesAsSecondStep(picture: Judged, userId: string, keys: BridgeKeys): boolean {
  return bridgeServes(picture) && opens(picture, userId, keys);
}

/** Whether the recorded bridge's secret opens with the keys we hold (not S9). */
function opens(picture: Pick<AccountPicture, 'bridge'>, userId: string, keys: BridgeKeys): boolean {
  const b = picture.bridge;
  if (!b) return false;
  return (
    openBridgeSecret(
      { ciphertext: b.secret_ciphertext, keyVersion: b.key_version },
      { userId, factorId: b.factor_id },
      keys,
    ) !== null
  );
}

/**
 * S7 and S13 (answer B, review 1 F1): a removal the member started, every
 * reserved-name factor made no later than the newest removal. Only these two
 * words, judged by the database's rule; never S17.
 */
function finishesRemoval(p: AccountPicture): boolean {
  if (p.state === 'removal_unfinished') return true;
  return p.state === 'bridge_row_without_passkey' && p.facts.bridgeStatus === 'verified';
}

/**
 * A removal the member started is finished only on a session that signed in
 * with the password: its verified `amr` holds `password` (review of stage 5,
 * finding 2). Never on a session an emailed link made (`otp`): the link alone
 * must not turn an account that lists a verified factor into one with none.
 */
function signedInWithPassword(held: Held): boolean {
  const amr = held.claims.amr;
  return (
    Array.isArray(amr) &&
    amr.some(
      (entry: unknown) =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { method?: unknown }).method === 'password',
    )
  );
}

/** Deletes the reserved-name factors of a removal the member started, then the row. */
async function finishMemberRemoval(
  admin: Admin,
  userId: string,
  p: AccountPicture,
): Promise<boolean> {
  const ids = p.factors.filter((f) => isReservedTotp(f)).map((f) => f.id);
  for (const id of ids) {
    try {
      const { error } = await admin.auth.admin.mfa.deleteFactor({ id, userId });
      if (error) return false;
    } catch {
      return false;
    }
  }
  if (p.bridge) {
    const { error } = await admin.rpc('passkey_drop_bridge', {
      p_user_id: userId,
      p_factor_id: p.bridge.factor_id,
    });
    if (error) return false;
  }
  return true;
}

/**
 * Finishes a ceremony of the second step (rule 20: the purpose is this
 * caller's constant): verify, then the state, then the bridge answer, then the
 * session raised in place, then the audit row with the session id (10.4).
 */
async function finishSecondStep(input: {
  challengeId: unknown;
  response: unknown;
}): Promise<Result<object>> {
  const p = await prologue('finish', 'use');
  if (!p.ok) return p;
  const { held, gate } = p;
  const userId = held.claims.userId;
  const admin = createAdminClient();
  const verified = await verifyAssertion(admin, held, gate.rp, 'second_step', input);
  if (!verified.ok) return verified;

  const read = await readPicture(admin, held, gate.rp);
  if (!read.ok) return read;
  const picture = read.picture;
  if (!bridgeServes(picture) || !picture.bridge) {
    if (setupUnfinished(picture))
      return fail('validation_error', PASSKEY_WORDS.setupNotFinished, 'setup_unfinished');
    reportPasskeys(picture.state, 'error', userId);
    return fail('forbidden', PASSKEY_WORDS.cantUse, picture.state);
  }
  const bridge = picture.bridge;
  const secret = openBridgeSecret(
    { ciphertext: bridge.secret_ciphertext, keyVersion: bridge.key_version },
    { userId, factorId: bridge.factor_id },
    gate.keys,
  );
  if (!secret) {
    reportPasskeys('bridge_unopenable', 'error', userId);
    return fail('forbidden', PASSKEY_WORDS.cantUse, 'bridge_unopenable');
  }
  const raise = await recordRaise(userId, held.claims.sessionId, 'second_step');
  if (!raise.ok) return raise;
  const answered = await answerBridge(held.token, userId, bridge.factor_id, secret);
  if (!answered.ok) return answered;
  const adopted = await adoptRaisedSession(held, answered.session);
  if (!adopted.ok) return adopted;

  await auditPasskey('passkey.used', userId, {
    passkey_id: verified.row.id,
    purpose: 'second_step',
    backed_up: verified.backedUp,
    session_id: held.claims.sessionId,
    raise_id: raise.raiseId,
  });
  // A newer key: the row is sealed again with it, by the same factor (2.3).
  if (needsNewerKey(bridge.key_version, gate.keys)) {
    const sealed = sealBridgeSecret(secret, { userId, factorId: bridge.factor_id }, gate.keys);
    if (sealed) {
      const { error } = await admin.rpc('passkey_replace_bridge', {
        p_user_id: userId,
        p_old_factor_id: bridge.factor_id,
        p_new_factor_id: bridge.factor_id,
        p_secret_ciphertext: sealed.ciphertext,
        p_key_version: sealed.keyVersion,
      });
      if (error) reportPasskeys('reseal_failed', 'warning', userId);
    }
  }
  return { ok: true };
}

/**
 * The second step's start: a removal the member started (S7, S13) is
 * finished here, on a session that signed in with the password
 * (signedInWithPassword), deleting the reserved-name factors at Auth and then
 * the bridge row (finishMemberRemoval); otherwise the ceremony starts. The
 * only start that can delete. On a session an emailed link made it deletes
 * nothing ("This account has no passkey.").
 */
export async function startSecondStep(): Promise<Result<{ start: SecondStepStart }>> {
  const started = await readForStart('use');
  if (!started.ok) return started;
  const { admin, held, picture } = started;
  if (finishesRemoval(picture) && signedInWithPassword(held)) {
    const done = await finishMemberRemoval(admin, held.claims.userId, picture);
    return done
      ? { ok: true, start: { kind: 'removal_finished' } }
      : fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'removal_not_finished');
  }
  return startCeremony('second_step', started);
}

export async function completeSecondStep(input: {
  challengeId: unknown;
  response: unknown;
}): Promise<Result<object>> {
  return finishSecondStep(input);
}

/** The confirm_add ceremony's start (its answer is spent inside startAddPasskey only). */
export async function startConfirmAdd(): Promise<Result<{ start: SecondStepStart }>> {
  const started = await readForStart('add');
  if (!started.ok) return started;
  return startCeremony('confirm_add', started);
}

/** The finish_setup ceremony's start (its answer is spent inside finishPasskeySetup only). */
export async function startFinishSetup(): Promise<Result<{ start: SecondStepStart }>> {
  const started = await readForStart('use');
  if (!started.ok) return started;
  return startCeremony('finish_setup', started);
}

// ── C. D. Adding a passkey ─────────────────────────────────────────────

export type AddProof =
  | { kind: 'password'; password: string }
  | { kind: 'code'; factorId: string; code: string }
  | { kind: 'passkey'; challengeId: string; response: unknown };

/** I understand, typed (trimmed, any case): the phone confirmation (2.6 C.3a). */
export const PHONE_CONFIRMATION_WORDS = 'i understand';

/** Whether this account's sign-in rows show the phone app in the last 30 days (closed on a failed read). */
async function usedPhoneAppRecently(admin: Admin, userId: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * MIN).toISOString();
    const { data, error } = await admin
      .from('audit_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('event', 'user.signed_in')
      .eq('metadata->>client', 'mobile')
      .gte('created_at', since)
      .limit(1);
    if (error || !Array.isArray(data)) return true;
    return data.length > 0;
  } catch {
    return true;
  }
}

/**
 * C: the fresh proof, by what the account has, then the registration
 * options. The `register` challenge is issued only here, after the proof.
 */
export async function startAddPasskey(input: {
  proof: unknown;
  phoneConfirmation?: unknown;
}): Promise<Result<{ challengeId: string; optionsJSON: unknown }>> {
  const p = await prologue('register', 'add');
  if (!p.ok) return p;
  const { held, gate } = p;
  const userId = held.claims.userId;
  const admin = createAdminClient();
  const read = await readPicture(admin, held, gate.rp);
  if (!read.ok) return read;
  const picture = read.picture;
  // Rule 14: the console's allowlist, read against Auth's own email for the account.
  if (isPlatformAdmin(picture.email)) return fail('forbidden', PASSKEY_WORDS.console, 'console');
  if (gate.atLimit) return fail('validation_error', PASSKEY_WORDS.atLimit, 'at_limit');
  if (!picture.bridge && picture.factors.length >= 10) {
    return fail('validation_error', PASSKEY_WORDS.removeAuthenticatorFirst, 'factor_limit');
  }
  if (setupUnfinished(picture)) {
    return fail(
      'validation_error',
      onlyMethodUnfinished(picture)
        ? PASSKEY_WORDS.finishFirstOnlyMethod
        : PASSKEY_WORDS.finishFirst,
      'setup_unfinished',
    );
  }

  const anyVerified = picture.factors.some((f) => f.status === 'verified');
  // Rule 19: an account with a verified factor adds only from an aal2 session.
  if (anyVerified && held.claims.aal !== 'aal2')
    return fail('forbidden', PASSKEY_WORDS.stepUpFirst, 'aal2_required');

  const proof = input.proof as AddProof | null | undefined;
  if (!proof || typeof proof !== 'object')
    return fail('validation_error', PASSKEY_WORDS.proofNeeded, 'proof');
  if (!anyVerified && picture.active.length === 0) {
    // No method: the password.
    if (proof.kind !== 'password' || typeof proof.password !== 'string' || !proof.password) {
      return fail('validation_error', PASSKEY_WORDS.proofNeeded, 'proof');
    }
    if (!picture.email) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'no_email');
    const checked = await verifyPasswordSideChannel(picture.email, proof.password);
    if (!checked.ok) {
      return checked.reason === 'invalid_password'
        ? fail('validation_error', PASSKEY_WORDS.passwordWrong, 'password')
        : fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'password_unchecked');
    }
  } else if (proof.kind === 'code') {
    // An authenticator app (never the bridge, by id).
    const app = picture.apps.find((f) => f.id === proof.factorId);
    if (!app || typeof proof.code !== 'string' || !/^\d{6}$/.test(proof.code)) {
      return fail('validation_error', PASSKEY_WORDS.codeWrong, 'code');
    }
    const check = await checkMfaCode(held.supabase, {
      userId,
      factorId: app.id,
      code: proof.code,
      path: 'add_passkey',
      sessionAal: held.claims.aal,
    });
    if (check.kind === 'budget_spent')
      return fail('rate_limited', PASSKEY_WORDS.tooMany, 'code_budget');
    if (check.kind === 'account_changed')
      return fail('unauthenticated', PASSKEY_WORDS.sessionEnded, 'account_changed');
    if (check.kind !== 'verified') return fail('validation_error', PASSKEY_WORDS.codeWrong, 'code');
  } else if (proof.kind === 'passkey' && picture.active.length > 0) {
    const confirmed = await verifyAssertion(admin, held, gate.rp, 'confirm_add', {
      challengeId: proof.challengeId,
      response: proof.response,
    });
    if (!confirmed.ok) return confirmed;
  } else {
    return fail('validation_error', PASSKEY_WORDS.proofNeeded, 'proof');
  }

  // 2.6 C.3a: no authenticator app and the phone app used in 30 days.
  if (picture.apps.length === 0 && (await usedPhoneAppRecently(admin, userId))) {
    const typed =
      typeof input.phoneConfirmation === 'string'
        ? input.phoneConfirmation.trim().toLowerCase()
        : '';
    if (typed !== PHONE_CONFIRMATION_WORDS) {
      return fail('validation_error', PASSKEY_WORDS.phoneConfirmation, 'phone_confirmation');
    }
  }

  // Review 4 finding 8, review B2: an old leftover of a failed Add goes now
  // (judged on a fresh read); never a verified one, never one in flight.
  if ((await clearAddLeftovers(admin, held, picture)) === null)
    return fail('internal_error', PASSKEY_WORDS.addFailed, 'leftover_left');

  const challenge = newChallenge();
  const label = picture.email ?? userId;
  const optionsJSON = await generateRegistrationOptions({
    rpName: 'StockPilot',
    rpID: gate.rp.rpId,
    userName: label,
    userID: ownBytes(Buffer.from(userId, 'utf8')),
    userDisplayName: label,
    challenge: challenge.bytes,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: picture.active.map((r) => ({
      id: r.credential_id,
      transports: (r.transports ?? []) as never,
    })),
    supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
    timeout: PROMPT_TIMEOUT_MS,
  });
  const issued = await issueChallenge(admin, held, 'register', gate.rp, challenge.text);
  if (!issued.ok) return issued;
  return { ok: true, challengeId: issued.challengeId, optionsJSON };
}

/** Deletes a factor this request enrolled (service role). False when it could not. */
async function deleteFactor(admin: Admin, userId: string, factorId: string): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: factorId, userId });
    return !error;
  } catch {
    return false;
  }
}

/** Deletes a factor this request enrolled; one it cannot delete is reported as `tag`. */
async function deleteOwnFactor(
  admin: Admin,
  userId: string,
  factorId: string,
  tag: 'add_factor_left' | 'finish_factor_left',
): Promise<void> {
  if (!(await deleteFactor(admin, userId, factorId))) reportPasskeys(tag, 'error', userId);
}

/**
 * Review 4 finding 8, review B2: the leftover of a failed Add is an
 * UNVERIFIED factor with the reserved name that is not the recorded
 * bridge's, made more than two minutes ago (reservedFactorInFlight, the rule
 * enrollFactorAction uses): only the request that enrolled a factor holds
 * its secret, so one that old can never become verified. It goes before an
 * Add enrols. A younger one is an Add in flight elsewhere: left alone, and
 * this Add goes on beside it. Both the "unverified" and the age are judged on
 * Auth's answer read right before the delete, never on the picture the
 * action started from (a proof comes between). That read is made only when
 * the picture shows such a factor. The factors left (the fresh list without
 * the ones deleted), or null when the read or a delete failed (reported at
 * error level; the member gets the Add's own words).
 */
async function clearAddLeftovers(
  admin: Admin,
  held: Held,
  picture: AccountPicture,
): Promise<AuthFactor[] | null> {
  const userId = held.claims.userId;
  const stale = (factors: AuthFactor[]) =>
    factors.filter(
      (f) =>
        isReservedTotp(f) &&
        f.status !== 'verified' &&
        f.id !== picture.bridge?.factor_id &&
        !reservedFactorInFlight(f.created_at),
    );
  if (stale(picture.factors).length === 0) return picture.factors;
  const now = await readAccountAs(held.token);
  if (!now || now.id !== userId) {
    reportPasskeys('add_leftover_left', 'error', userId, { step: 'read' });
    return null;
  }
  const deleted = new Set<string>();
  for (const f of stale(now.factors)) {
    if (!(await deleteFactor(admin, userId, f.id))) {
      reportPasskeys('add_leftover_left', 'error', userId, { step: 'delete' });
      return null;
    }
    deleted.add(f.id);
  }
  return now.factors.filter((f) => !deleted.has(f.id));
}

/**
 * D: verify the device's new passkey, then store it with its bridge (a new
 * one for the first passkey; the healthy one otherwise), then answer a new
 * bridge so this session rides it. A failure after the store is compensated
 * in this request (setup_failed), never by removing other passkeys.
 */
export async function finishAddPasskey(input: {
  challengeId: unknown;
  response: unknown;
  name: unknown;
}): Promise<Result<{ passkeyId: string; firstPasskey: boolean }>> {
  const p = await prologue('finish', 'add');
  if (!p.ok) return p;
  const { held, gate } = p;
  const userId = held.claims.userId;
  const name = passkeyNameSchema.safeParse(input.name);
  if (!name.success) return fail('validation_error', PASSKEY_WORDS.nameInvalid, 'name');
  const challengeId = challengeIdSchema.safeParse(input.challengeId);
  const response = registrationResponseSchema.safeParse(input.response);
  if (!challengeId.success || !response.success)
    return fail('validation_error', PASSKEY_WORDS.refused, 'shape');
  const admin = createAdminClient();
  const taken = await takeChallenge(admin, held, 'register', gate.rp, challengeId.data);
  if (!taken.ok) return taken;

  const answer = response.data;
  if (answer.id !== answer.rawId) return refuseByVerdict('refused', userId);
  const crossOrigin = crossOriginOf(answer.response.clientDataJSON);
  if (crossOrigin === null) return refuseByVerdict('refused', userId);
  if (crossOrigin) return refuseByVerdict('wrong_site', userId);
  const refusedFormat = refusedAttestationFormat(answer.response.attestationObject);
  if (refusedFormat !== null) {
    await recordPasskeyEvent('passkey_refused', userId);
    await reportRefusedFormat(userId, refusedFormat);
    return fail('validation_error', PASSKEY_WORDS.formatRefused, 'attestation_format');
  }
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: answer,
      expectedChallenge: taken.challenge,
      expectedOrigin: [...gate.rp.origins],
      expectedRPID: gate.rp.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
    });
  } catch (e) {
    return refuseByVerdict(verdictOfLibraryError(e), userId);
  }
  if (verification.verified !== true || !verification.registrationInfo.userVerified) {
    return refuseByVerdict('no_user_verification', userId);
  }
  const info = verification.registrationInfo;
  if (info.credential.id !== answer.rawId) return refuseByVerdict('refused', userId);
  const publicKey = Buffer.from(info.credential.publicKey);
  if (
    publicKey.length < 32 ||
    publicKey.length > 2048 ||
    publicKey[0]! < 0xa0 ||
    publicKey[0]! > 0xbf
  ) {
    return refuseByVerdict('refused', userId);
  }

  // The gate again: it may have changed in two minutes (D.3).
  const again = await passkeyGate(userId);
  if (!again.open) return fail('forbidden', PASSKEY_WORDS.unavailable, `gate_${again.why}`);
  if (again.atLimit) return fail('validation_error', PASSKEY_WORDS.atLimit, 'at_limit');

  const read = await readPicture(admin, held, gate.rp);
  if (!read.ok) return read;
  const picture = read.picture;
  if (isPlatformAdmin(picture.email)) return fail('forbidden', PASSKEY_WORDS.console, 'console');
  const anyVerified = picture.factors.some((f) => f.status === 'verified');
  if (anyVerified && held.claims.aal !== 'aal2')
    return fail('forbidden', PASSKEY_WORDS.stepUpFirst, 'aal2_required');

  // The bridge: a new one when the account has no bridge row; the healthy
  // one otherwise. Any half state is finished first (Finish), never here.
  let enrolled: {
    factorId: string;
    secret: string;
    sealed: { ciphertext: string; keyVersion: number };
  } | null = null;
  if (!picture.bridge) {
    let state = picture.state;
    if (state === 'unverified_reserved_factor') {
      // Review 4 finding 8: an old leftover goes before this Add enrols; the
      // state is judged again on the factors left.
      const left = await clearAddLeftovers(admin, held, picture);
      if (left === null) return fail('internal_error', PASSKEY_WORDS.addFailed, 'leftover_left');
      state = judged(picture.rows, null, left, gate.rp).state;
    }
    // Review B2: an unverified reserved-name factor still there is one in
    // flight elsewhere (under two minutes old): this Add enrols beside it
    // (Auth drops an unverified TOTP factor once another is answered; the
    // upkeep takes what is left).
    if (state !== 'nothing' && state !== 'healthy' && state !== 'unverified_reserved_factor') {
      reportPasskeys(state, 'error', userId);
      return fail('forbidden', PASSKEY_WORDS.cantUse, state);
    }
    const made = await enrolTotpAs(held.token, bridgeFactorName());
    if (!made.ok) {
      // An answer with an id and no secret made a factor: it goes at once.
      if (made.factorId) await deleteOwnFactor(admin, userId, made.factorId, 'add_factor_left');
      if (made.code === 'insufficient_aal')
        return fail('forbidden', PASSKEY_WORDS.stepUpFirst, 'insufficient_aal');
      if (made.code === 'too_many_enrolled_factors') {
        return fail('validation_error', PASSKEY_WORDS.removeAuthenticatorFirst, 'factor_limit');
      }
      reportPasskeys('enrol_refused', 'warning', userId, { code: made.code });
      return fail('internal_error', PASSKEY_WORDS.addFailed, 'enrol_refused');
    }
    const sealed = sealBridgeSecret(made.secret, { userId, factorId: made.factorId }, gate.keys);
    if (!sealed) {
      await deleteOwnFactor(admin, userId, made.factorId, 'add_factor_left');
      return fail('internal_error', PASSKEY_WORDS.addFailed, 'not_sealed');
    }
    enrolled = { factorId: made.factorId, secret: made.secret, sealed };
  } else if (!bridgeServes(picture) || !opens(picture, userId, gate.keys)) {
    return fail('validation_error', PASSKEY_WORDS.finishFirst, 'bridge_not_healthy');
  }

  const transports = cleanTransports(answer.response.transports);
  const stored = await admin.rpc('passkey_register', {
    p_user_id: userId,
    p_credential_id: info.credential.id,
    p_public_key: `\\x${publicKey.toString('hex')}`,
    p_counter: info.credential.counter,
    p_transports: transports,
    p_backup_eligible: info.credentialDeviceType === 'multiDevice',
    p_backed_up: info.credentialBackedUp,
    p_name: name.data,
    p_rp_id: gate.rp.rpId,
    p_factor_id: enrolled?.factorId ?? null,
    p_secret_ciphertext: enrolled?.sealed.ciphertext ?? null,
    p_key_version: enrolled?.sealed.keyVersion ?? null,
  });
  const passkeyId = typeof stored.data === 'string' ? stored.data : null;
  if (stored.error || !passkeyId) {
    // Review 4 finding 8: a factor this Add made and cannot delete is reported.
    if (enrolled) await deleteOwnFactor(admin, userId, enrolled.factorId, 'add_factor_left');
    const code = (stored.error as { code?: unknown } | null)?.code;
    if (code !== '55000')
      reportPasskeys('register_failed', 'warning', userId, {
        code: typeof code === 'string' ? code : 'none',
      });
    return fail('internal_error', PASSKEY_WORDS.addFailed, 'register_failed');
  }

  let raiseId: string | null = null;
  if (enrolled) {
    // Only the id enrolled in THIS registration is answered (stage 2-3 review finding 13).
    const raise = await recordRaise(userId, held.claims.sessionId, 'add');
    raiseId = raise.ok ? raise.raiseId : null;
    const answered = raise.ok
      ? await answerBridge(held.token, userId, enrolled.factorId, enrolled.secret)
      : raise;
    const adopted = answered.ok ? await adoptRaisedSession(held, answered.session) : answered;
    if (!adopted.ok) {
      const undo = await admin.rpc('passkey_mark_removed', {
        p_user_id: userId,
        p_passkey_id: passkeyId,
        p_reason: 'setup_failed',
      });
      const undone = Array.isArray(undo.data) ? undo.data[0] : undo.data;
      if (undo.error || !(undone as { bridge_dropped?: unknown } | null)?.bridge_dropped) {
        reportPasskeys('setup_compensation_incomplete', 'error', userId);
      } else if (!(await deleteFactor(admin, userId, enrolled.factorId))) {
        reportPasskeys('setup_factor_left', 'error', userId);
      }
      return fail(adopted.code, PASSKEY_WORDS.addNotFinished, adopted.reason ?? 'answer_failed');
    }
  }

  await auditPasskey('passkey.added', userId, {
    passkey_id: passkeyId,
    backed_up: info.credentialBackedUp,
    transports,
    fmt: info.fmt,
    session_id: held.claims.sessionId,
    raise_id: raiseId,
  });
  if (picture.email) await sendPasskeyAddedEmail(picture.email);
  return { ok: true, passkeyId, firstPasskey: enrolled !== null };
}

// ── Finish setup (S2, S4, S10) and repair (S9) ─────────────────────────

/**
 * After a finish_setup ceremony: a new bridge is enrolled and answered, then
 * swapped in for the row's (compare and swap), then the old factor is
 * deleted. The new bridge is verified BEFORE the swap (a repair never
 * deletes a verified bridge first) and the swap follows at once.
 */
export async function finishPasskeySetup(input: {
  challengeId: unknown;
  response: unknown;
}): Promise<Result<object>> {
  const p = await prologue('finish', 'use');
  if (!p.ok) return p;
  const { held, gate } = p;
  const userId = held.claims.userId;
  const admin = createAdminClient();
  const verified = await verifyAssertion(admin, held, gate.rp, 'finish_setup', input);
  if (!verified.ok) return verified;
  const read = await readPicture(admin, held, gate.rp);
  if (!read.ok) return read;
  const picture = read.picture;
  const repair = bridgeServes(picture) && !opens(picture, userId, gate.keys);
  if (!setupUnfinished(picture) && !repair)
    return fail('validation_error', PASSKEY_WORDS.couldNotFinish, 'nothing_to_finish');
  // Decision A: the row this ceremony just used is read as it was before.
  const usedBefore = (r: PasskeyRow) =>
    r.id === verified.row.id ? verified.row.last_used_at !== null : r.last_used_at !== null;
  if (!existingHolder(picture, userId, gate.keys, usedBefore) && !gate.addOpen)
    return gateRefusal(gate.addWhy ?? 'unreadable');
  const anyVerified = picture.factors.some((f) => f.status === 'verified');
  if (anyVerified && held.claims.aal !== 'aal2')
    return fail('forbidden', PASSKEY_WORDS.stepUpFirst, 'aal2_required');
  const before = new Set(picture.factors.filter((f) => f.status === 'verified').map((f) => f.id));

  const made = await enrolTotpAs(held.token, bridgeFactorName());
  if (!made.ok) {
    if (made.factorId) await deleteOwnFactor(admin, userId, made.factorId, 'finish_factor_left');
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'enrol_refused');
  }
  const sealed = sealBridgeSecret(made.secret, { userId, factorId: made.factorId }, gate.keys);
  if (!sealed) {
    await deleteOwnFactor(admin, userId, made.factorId, 'finish_factor_left');
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'not_sealed');
  }
  const raise = await recordRaise(userId, held.claims.sessionId, 'finish_setup');
  const answered = raise.ok
    ? await answerBridge(held.token, userId, made.factorId, made.secret)
    : raise;
  const adopted = answered.ok ? await adoptRaisedSession(held, answered.session) : answered;
  if (!adopted.ok) {
    if (!(await deleteFactor(admin, userId, made.factorId)))
      reportPasskeys('finish_factor_left', 'error', userId);
    return adopted;
  }
  const old = picture.bridge?.factor_id ?? null;
  const swapped = await admin.rpc('passkey_replace_bridge', {
    p_user_id: userId,
    p_old_factor_id: old,
    p_new_factor_id: made.factorId,
    p_secret_ciphertext: sealed.ciphertext,
    p_key_version: sealed.keyVersion,
  });
  if (swapped.error || swapped.data !== true) {
    // The new factor is verified and not recorded: removed at once.
    if (!(await deleteFactor(admin, userId, made.factorId)))
      reportPasskeys('finish_factor_left', 'error', userId);
    if (repair) reportPasskeys('repair_stopped', 'error', userId);
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'swap_failed');
  }
  if (
    old &&
    picture.factors.some((f) => f.id === old) &&
    !(await deleteFactor(admin, userId, old))
  ) {
    reportPasskeys('old_bridge_left', 'error', userId);
  }
  if (repair) {
    // 10.3: after a repair, any verified factor that is not the new bridge
    // and was not there before is removed, and reported.
    const now = await readAccountAs(held.token);
    const extra = (now?.factors ?? []).filter(
      (f) => f.status === 'verified' && f.id !== made.factorId && !before.has(f.id),
    );
    for (const f of extra) await deleteFactor(admin, userId, f.id);
    if (extra.length > 0)
      reportPasskeys('repair_found_new_factor', 'error', userId, { count: extra.length });
  }
  await auditPasskey('passkey.bridge_repaired', userId, {
    state: repair ? 'bridge_unopenable' : picture.state,
    session_id: held.claims.sessionId,
    raise_id: raise.ok ? raise.raiseId : null,
  });
  return { ok: true };
}

// ── E. F. Remove and rename ────────────────────────────────────────────

/** E: remove one of the member's passkeys (aal2), then end the other sessions. */
export async function removePasskey(input: {
  passkeyId: unknown;
}): Promise<Result<{ finishing: boolean }>> {
  // Decision A: the MANAGE level (a site; no key, no switch).
  const p = await managePrologue('remove');
  if (!p.ok) return p;
  const { held, rp } = p;
  const userId = held.claims.userId;
  if (held.claims.aal !== 'aal2') {
    // Review 4 finding 4: an account whose only method is a passkey whose
    // setup is not finished cannot reach aal2 at all; its words say the two
    // ways out. Anyone else: confirm it is you first.
    const read = await readPicture(createAdminClient(), held, rp);
    const only = read.ok && onlyMethodUnfinished(read.picture);
    return fail(
      'forbidden',
      only ? PASSKEY_WORDS.onlyMethodUnfinished : PASSKEY_WORDS.stepUpFirst,
      'aal2_required',
    );
  }
  const id = challengeIdSchema.safeParse(input.passkeyId);
  if (!id.success) return fail('validation_error', PASSKEY_WORDS.alreadyRemoved, 'id');
  const admin = createAdminClient();
  const read = await readPicture(admin, held, rp);
  if (!read.ok) return read;
  const picture = read.picture;
  const target = picture.rows.find((r) => r.id === id.data && r.removed_at === null);
  if (!target) return fail('not_found', PASSKEY_WORDS.alreadyRemoved, 'not_found');
  // Decision B: the account's last second-step method (apps and passkeys
  // counted alike), under a policy of any organization of the member. With
  // the corrections: the passkeys counted are those that serve now (the USE
  // level, read only when no app would remain, and the page's own
  // judgement), else none; what cannot be read is "try again".
  const verdict = await lastMethodVerdict({
    userId,
    removing: { kind: 'passkey', passkeyId: target.id },
    factors: picture.factors,
    servingPasskeys: async () => {
      const use = await passkeyUseGate(userId);
      if (!use.open) return use.why === 'unreadable' ? null : [];
      return servesAsSecondStep(picture, userId, use.keys) ? picture.active.map((r) => r.id) : [];
    },
  });
  if (verdict === 'last_method')
    return fail('forbidden', PASSKEY_WORDS.policyBlocksRemoval, 'policy');
  if (verdict === 'unreadable')
    return fail('internal_error', LAST_METHOD_RETRY_WORDS, 'last_method_unreadable');
  // The other sessions, listed before anything ends (for the broadcast).
  const asMember = createAccessTokenClient(held.token);
  const listed = await listMySessionIds(asMember);

  const { data, error } = await admin.rpc('passkey_mark_removed', {
    p_user_id: userId,
    p_passkey_id: id.data,
    p_reason: 'member',
  });
  const answer = (Array.isArray(data) ? data[0] : data) as
    { removed?: unknown; bridge_factor_id?: unknown; bridge_dropped?: unknown } | null | undefined;
  if (error || !answer)
    return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'remove_failed');
  if (answer.removed !== true)
    return fail('not_found', PASSKEY_WORDS.alreadyRemoved, 'not_removed');
  let finishing = false;
  if (answer.bridge_dropped === true && typeof answer.bridge_factor_id === 'string') {
    if (!(await deleteFactor(admin, userId, answer.bridge_factor_id))) {
      finishing = true;
      reportPasskeys('removal_factor_left', 'error', userId);
    }
  }
  // A removed passkey's sessions are not ended by Supabase (spike Q11): every
  // OTHER session of the account ends; this one stays.
  const others = await signOutAs(held.token, 'others');
  if (!others.ok && held.claims.sessionId) {
    const { error: revokeError } = await asMember.rpc('revoke_my_other_sessions', {
      p_keep_session_id: held.claims.sessionId,
    });
    if (revokeError) reportPasskeys('other_sessions_not_ended', 'error', userId);
  }
  if (held.claims.sessionId) {
    try {
      await broadcastEndedSessions(userId, listed, held.claims.sessionId);
    } catch {
      // Best effort: the refresh tokens are revoked either way.
    }
  }
  await auditPasskey('passkey.removed', userId, { passkey_id: id.data, reason: 'member' });
  if (picture.email) sendPasskeyRemovedEmail(picture.email);
  return { ok: true, finishing };
}

/** F: rename one of the member's passkeys (aal2; the table's name rule). */
export async function renamePasskey(input: {
  passkeyId: unknown;
  name: unknown;
}): Promise<Result<object>> {
  // Decision A: the MANAGE level (a site; no key, no switch).
  const p = await managePrologue('manage');
  if (!p.ok) return p;
  const { held } = p;
  if (held.claims.aal !== 'aal2')
    return fail('forbidden', PASSKEY_WORDS.stepUpFirst, 'aal2_required');
  const id = challengeIdSchema.safeParse(input.passkeyId);
  const name = passkeyNameSchema.safeParse(input.name);
  if (!id.success) return fail('validation_error', PASSKEY_WORDS.alreadyRemoved, 'id');
  if (!name.success) return fail('validation_error', PASSKEY_WORDS.nameInvalid, 'name');
  const { data, error } = await createAdminClient()
    .from('member_passkeys')
    .update({ name: name.data })
    .eq('id', id.data)
    .eq('user_id', held.claims.userId)
    .is('removed_at', null)
    .select('id');
  if (error) return fail('internal_error', PASSKEY_WORDS.couldNotFinish, 'rename_failed');
  if (!Array.isArray(data) || data.length !== 1)
    return fail('not_found', PASSKEY_WORDS.alreadyRemoved, 'not_found');
  return { ok: true };
}

// ── What the pages show ────────────────────────────────────────────────

export interface PasskeyListItem {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  /** Setup not finished (S2, S4, S10): Finish and Remove. */
  unfinished: boolean;
}

export interface PasskeysPanel {
  passkeys: PasskeyListItem[];
  /**
   * Decision A: null, the whole panel; otherwise the passkeys with Remove and
   * one sentence, nothing else ('turned_off': the kill switch is off;
   * 'unavailable': no key, or the switch could not be read).
   */
  listOnly: 'turned_off' | 'unavailable' | null;
  /** Add is offered: the ADD level holds (every condition). */
  canAdd: boolean;
  /** Finish is offered for a setup not finished: an existing holder (USE level), or the ADD level. */
  canFinish: boolean;
  atLimit: boolean;
  hasApp: boolean;
  /** The proof the Add flow asks for. */
  proof: 'password' | 'code' | 'passkey_or_code' | 'passkey';
  apps: Array<{ id: string; friendlyName: string | null }>;
  /** Show the phone app screen before the device prompt (2.6 C.3a). */
  phoneConfirmation: boolean;
  /** This session is aal2 (adding with a verified factor, removing, renaming need it). */
  aal2: boolean;
  /**
   * Review 4 finding 4: a setup not finished and no verified factor at all,
   * so this account cannot reach aal2 to remove it: the panel says the two
   * ways out (an authenticator app first, or a recovery code).
   */
  onlyMethodUnfinished: boolean;
}

/**
 * The Security page's Passkeys panel for the signed-in member, or null when
 * it must be ABSENT (review finding 10; decision A): no site, a disabled
 * account, a console account, anything unreadable, or a member who cannot
 * add a passkey and has none. A member who has passkeys of this site always
 * sees them with Remove, whatever the switches say (listOnly when the kill
 * switch is off, the key is missing or the switch cannot be read).
 *
 * Dark (review 4 finding 6, review B3), names first as passkeyHolder:
 * `factors` is the factor list the page's service context already read
 * (null: not known). Without a factor carrying the reserved bridge name, the
 * panel is shown only when THIS member can add a passkey; otherwise it is
 * absent at the cost of at most one read: no site reads nothing, no key reads
 * nothing (the database is not asked), and anything else (the kill switch
 * off, new passkeys off, an organization of the member off, no organization)
 * is the one passkey_add_allowed answer. No member_passkeys or
 * passkey_bridges read, no Auth call, and no second read of the session. So a
 * passkey left unfinished with no reserved-name factor (S2, S10) is not shown
 * until adding is open to the member again, whatever closed it. A holder (the
 * name listed) still gets their list with Remove.
 */
export async function passkeysPanelFor(
  userId: string,
  factors: ReadonlyArray<{ friendly_name?: unknown }> | null,
): Promise<PasskeysPanel | null> {
  try {
    return await panelOf(userId, factors);
  } catch {
    return null;
  }
}

async function panelOf(
  userId: string,
  factors: ReadonlyArray<{ friendly_name?: unknown }> | null,
): Promise<PasskeysPanel | null> {
  const rp = passkeyRelyingParty();
  if (!rp) return null;
  const named = factors !== null && factors.some(carriesBridgeName);
  const gate = gateForUse(await readGate(userId));
  const canAdd = gate.open && gate.addOpen;
  // Review B3: no reserved-name factor and adding not open to this member.
  if (!named && !canAdd) return null;
  if (!gate.open && (gate.why === 'disabled' || gate.why === 'no_profile')) return null;
  const held = await holdSession();
  if (!held || held.claims.userId !== userId) return null;
  const admin = createAdminClient();
  if (!canAdd) {
    // Only a member who has passkeys of this site sees the panel now.
    const rows = await readRows(admin, userId, rp.rpId);
    if (rows === null || !rows.some((r) => r.removed_at === null && r.rp_id === rp.rpId))
      return null;
  }
  const read = await readPicture(admin, held, rp);
  if (!read.ok) return null;
  const picture = read.picture;
  if (isPlatformAdmin(picture.email)) return null;
  const unfinished = setupUnfinished(picture);
  const hasPasskey = picture.active.length > 0;
  const hasApp = picture.apps.length > 0;
  return {
    passkeys: picture.active.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      backedUp: r.backed_up,
      unfinished,
    })),
    listOnly: gate.open ? null : gate.why === 'kill_switch_off' ? 'turned_off' : 'unavailable',
    canAdd,
    canFinish:
      gate.open &&
      unfinished &&
      (canAdd || existingHolder(picture, userId, gate.keys, (r) => r.last_used_at !== null)),
    atLimit: gate.open && gate.atLimit,
    hasApp,
    proof:
      !hasPasskey && !hasApp
        ? picture.factors.some((f) => f.status === 'verified')
          ? 'code'
          : 'password'
        : hasPasskey && hasApp
          ? 'passkey_or_code'
          : hasPasskey
            ? 'passkey'
            : 'code',
    apps: picture.apps.map((f) => ({ id: f.id, friendlyName: f.friendly_name })),
    phoneConfirmation: canAdd && !hasApp && (await usedPhoneAppRecently(admin, userId)),
    aal2: held.claims.aal === 'aal2',
    onlyMethodUnfinished: onlyMethodUnfinished(picture),
  };
}

/**
 * What the second-step page and the step-up modal offer for an account whose
 * factor list carries `factors`: 'ready' (the passkey answers), or 'none'
 * (stage 2's behaviour exactly). Read only when a reserved-name factor is
 * listed, so an account without a passkey costs nothing.
 */
export async function passkeyStepFor(
  userId: string,
  factors: ReadonlyArray<{ friendly_name?: unknown; factor_type?: unknown }>,
): Promise<'ready' | 'none'> {
  try {
    return await stepOf(userId, factors);
  } catch {
    // Never a broken page: anything unexpected is stage 2's page, exactly.
    return 'none';
  }
}

async function stepOf(
  userId: string,
  factors: ReadonlyArray<{ friendly_name?: unknown; factor_type?: unknown }>,
): Promise<'ready' | 'none'> {
  if (!factors.some(carriesBridgeName)) return 'none';
  // Decision A: the USE level (site, key, kill switch); an organization
  // switched off never takes an existing holder's second step away.
  const gate = await passkeyUseGate(userId);
  if (!gate.open) {
    // Review 4 finding 1: a missing key is a fault to see, not a choice.
    if (gate.why === 'no_key') await reportStepFault(userId, 'no_key');
    return 'none';
  }
  const held = await holdSession();
  if (!held || held.claims.userId !== userId) return 'none';
  const read = await readPicture(createAdminClient(), held, gate.rp);
  if (!read.ok) return 'none';
  const picture = read.picture;
  if (finishesRemoval(picture)) return signedInWithPassword(held) ? 'ready' : 'none';
  if (servesAsSecondStep(picture, userId, gate.keys)) return 'ready';
  const fault = failClosedFault(picture, userId, gate.keys);
  if (fault) await reportStepFault(userId, fault);
  return 'none';
}

/**
 * Decision B, correction 1 (2026-11-21): the ids of the account's passkeys
 * that can ACTUALLY serve as its second step now, judged as the second-step
 * page judges them (stepOf): the USE level open (a site, a key, the kill
 * switch on, the account on) and servesAsSecondStep (an active row of this
 * site, a recorded bridge whose reserved-name TOTP factor exists and is
 * verified in a state where the bridge answers, a secret the keys open).
 * A passkey row alone is no method.
 *
 * [] when none can serve (no site: nothing is read). null when it cannot be
 * told (correction 2): the factor list unknown (nothing is read; the bridge
 * cannot be judged without it), the switch unread, a record unread. Never
 * throws. `factors` is the caller's list of `userId`'s factors (the one
 * withContext() read); a factor without an id is left out.
 */
export async function servingPasskeyIds(
  userId: string,
  factors: ReadonlyArray<{
    id?: unknown;
    factor_type?: unknown;
    status?: unknown;
    friendly_name?: unknown;
    created_at?: unknown;
  }> | null,
): Promise<string[] | null> {
  try {
    if (!passkeyRelyingParty()) return [];
    if (factors === null) return null;
    const gate = await passkeyUseGate(userId);
    if (!gate.open) return gate.why === 'unreadable' ? null : [];
    const admin = createAdminClient();
    const [rows, bridge] = await Promise.all([
      readRows(admin, userId, gate.rp.rpId),
      readBridgeRow(admin, userId),
    ]);
    if (rows === null || bridge === 'unreadable') return null;
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    const listed: AuthFactorFact[] = factors.flatMap((f) =>
      typeof f.id === 'string'
        ? [
            {
              id: f.id,
              factor_type: text(f.factor_type),
              status: text(f.status),
              friendly_name: text(f.friendly_name),
              created_at: text(f.created_at),
            },
          ]
        : [],
    );
    const picture = judged(rows, bridge, listed, gate.rp);
    return servesAsSecondStep(picture, userId, gate.keys) ? picture.active.map((r) => r.id) : [];
  } catch {
    return null;
  }
}

/** The user handle of an account (tests and the registration options agree on it). */
export const __userHandleOfForTests = userHandleOf;
