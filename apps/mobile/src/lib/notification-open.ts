/**
 * WHAT TO DO WITH A CAPTURED TAP, STEP BY STEP (Phase 3, iPhone push tap).
 *
 * The steps are pure: NotificationIntentHost feeds nextOpenStep today's
 * signals and does what it answers. The order of the checks is the design:
 *
 *   1. nothing pending: idle;
 *   2. wait while MFA is still being checked after a password sign-in
 *      (mfaPending), while the navigator is not mounted, while there is no
 *      route, while the sign-in group is still showing (the redirect to Home
 *      has not run yet), or while the published route has not caught up with
 *      a navigator that just remounted (see focusedStackRoute);
 *   3. wait while whose tap it is is still being read;
 *   4. a tap for another account: the neutral notice; expired or unbound:
 *      dropped silently;
 *   5. a link the app cannot open: the notice with the push's own words;
 *   6. wait while the workspace is loading;
 *   7. an order or a return, for a user in more than one workspace: read its
 *      organization first (resolveTargetWorkspace);
 *   8. otherwise open it, unless it is already the screen in front.
 *
 * No timer decides readiness: every wait ends on a signal the host
 * re-renders on. The two timers here are the workspace read's network
 * deadline (TARGET_READ_TIMEOUT_MS), which ends a stalled read as a read
 * error, and the Checking notice's UI delay (CHECKING_NOTICE_DELAY_MS), which
 * only changes what the screen says while that read is out.
 * Single-workspace users pay no extra read: the destination screen's own
 * RLS-scoped read is the re-authorisation, with its own non-disclosing
 * "not found" state.
 *
 * The workspace read takes no organization from push data (the intent has no
 * organization field) and filters by NO organization: the active workspace is
 * exactly what is in question. RLS answers: order_requests_select and
 * returns_select are is_org_member. A switch is only ever offered, never made.
 */
import type { TakeResult } from './notification-intent';
import { errorClassOf, type PushOpenReason } from './push-open-diagnostics';

export type OpenWaitReason =
  | 'mfa-pending'
  | 'router-not-ready'
  | 'no-segments'
  | 'auth-group'
  | 'route-settling'
  | 'binding'
  | 'signed-out'
  | 'workspace-loading';

/** The published workspace, as the host reads it (useWorkspaceSnapshot). */
export interface WorkspaceView {
  loading: boolean;
  orgs: readonly { id: string; name: string }[];
  activeOrgId: string | null;
  activeOrgName: string | null;
}

export type ResolveTable = 'order_requests' | 'returns';

/** What the notices call the tapped record. */
export type TargetNoun = 'order' | 'return';

export function targetNoun(routeKind: string): TargetNoun {
  return routeKind === 'returns' ? 'return' : 'order';
}

export type IntentNotice =
  | { kind: 'account-mismatch' }
  | { kind: 'unsupported'; title: string | null; body: string | null }
  | { kind: 'unavailable' }
  | { kind: 'retry' }
  /** The workspace read is taking a while (createWorkspaceChecks). */
  | { kind: 'checking'; noun: TargetNoun }
  | {
      kind: 'switch';
      orgId: string;
      orgName: string;
      activeOrgName: string | null;
      noun: TargetNoun;
      native: string;
    };

export type OpenStep =
  | { kind: 'idle' }
  | { kind: 'wait'; reason: OpenWaitReason }
  | { kind: 'drop'; reason: 'expired' | 'unbound' }
  | { kind: 'notice'; notice: IntentNotice }
  | { kind: 'resolve'; table: ResolveTable; id: string }
  | { kind: 'navigate'; path: string }
  | { kind: 'stay' };

export interface OpenStepInput {
  take: TakeResult;
  /** auth-context: a password sign-in is still checking whether MFA is owed. */
  mfaPending: boolean;
  /** useNavigationContainerRef().isReady() */
  routerReady: boolean;
  /** The root Stack's focused route in the LIVE navigation state
   *  (focusedStackRoute), or null while the Stack has no state. */
  stackRoute: string | null;
  /** useSegments(): the route as expo-router last published it. */
  segments: readonly string[];
  pathname: string;
  workspace: WorkspaceView;
}

const AUTH_GROUP = '(auth)';

/** expo-router's root slot, which holds the app's root Stack. */
const ROOT_SLOT = '__root';

interface NavStateLike {
  index?: number;
  routes?: readonly { name?: string; state?: unknown }[];
}

function focusedRoute(state: unknown): { name?: string; state?: unknown } | null {
  const routes = (state as NavStateLike | null | undefined)?.routes;
  if (!routes || routes.length === 0) return null;
  const index = (state as NavStateLike).index ?? 0;
  return routes[index] ?? null;
}

/**
 * The root Stack's focused route name in a LIVE root state
 * (useNavigationContainerRef().getRootState()), or null while the Stack has
 * no state.
 *
 * Why not useSegments() alone: RootGate swaps the Stack for the MFA or Face
 * ID screen, the navigator clears its state when it unmounts, and
 * expo-router's store skips an undefined state, so the published route stays
 * the one from before. When the Stack remounts, the navigator tells the
 * container from an effect, AFTER the host's first look, so for that look
 * useSegments() is stale (it may say Home while the Stack is on the sign-in
 * group, its first declared screen). The live state is never stale.
 */
export function focusedStackRoute(rootState: unknown): string | null {
  const top = focusedRoute(rootState);
  if (!top?.name) return null;
  if (top.name !== ROOT_SLOT) return top.name;
  return focusedRoute(top.state)?.name ?? null;
}

/** The kinds whose organization is read for a multi-workspace user. */
const RESOLVED_KINDS: Record<string, ResolveTable> = {
  order: 'order_requests',
  returns: 'returns',
};

function openOrStay(native: string, pathname: string): OpenStep {
  return pathname === native ? { kind: 'stay' } : { kind: 'navigate', path: native };
}

export function nextOpenStep(input: OpenStepInput): OpenStep {
  const { take } = input;
  if (take.kind === 'none') return { kind: 'idle' };
  if (input.mfaPending) return { kind: 'wait', reason: 'mfa-pending' };
  if (!input.routerReady || input.stackRoute === null) {
    return { kind: 'wait', reason: 'router-not-ready' };
  }
  if (input.segments.length === 0) return { kind: 'wait', reason: 'no-segments' };
  if (input.stackRoute === AUTH_GROUP || input.segments[0] === AUTH_GROUP) {
    return { kind: 'wait', reason: 'auth-group' };
  }
  // 'order/[id]' is published as ['order', '[id]']: the heads agree once the
  // published route has caught up with the navigator.
  if (input.stackRoute.split('/')[0] !== input.segments[0]) {
    return { kind: 'wait', reason: 'route-settling' };
  }
  if (take.kind === 'waiting') return { kind: 'wait', reason: take.reason };
  if (take.kind === 'dropped') {
    return take.reason === 'account-mismatch'
      ? { kind: 'notice', notice: { kind: 'account-mismatch' } }
      : { kind: 'drop', reason: take.reason };
  }
  const { target, title, body } = take.intent;
  if (!target.ok) return { kind: 'notice', notice: { kind: 'unsupported', title, body } };
  if (input.workspace.loading) return { kind: 'wait', reason: 'workspace-loading' };
  const table = RESOLVED_KINDS[target.routeKind];
  if (table && target.resourceId && input.workspace.orgs.length > 1) {
    return { kind: 'resolve', table, id: target.resourceId };
  }
  return openOrStay(target.native, input.pathname);
}

export type TargetResolution =
  { kind: 'found'; orgId: string } | { kind: 'none' } | { kind: 'error'; errorClass: string };

export interface ResolutionInput {
  /** The tap the read was made for. */
  answerSeq: number;
  /** The tap pending now (null: none). */
  currentSeq: number | null;
  resolution: TargetResolution;
  native: string;
  routeKind: string;
  workspace: WorkspaceView;
  pathname: string;
}

/** What the workspace read means for the tap it was made for. */
export function stepAfterResolution(input: ResolutionInput): OpenStep {
  // A newer tap (or a sign-out) took the slot while the read was out.
  if (input.currentSeq === null || input.answerSeq !== input.currentSeq) return { kind: 'idle' };
  const { resolution } = input;
  const { activeOrgId, activeOrgName, orgs } = input.workspace;
  if (resolution.kind === 'error') return { kind: 'notice', notice: { kind: 'retry' } };
  // Missing and not shared look the same under RLS, and say the same.
  if (resolution.kind === 'none') return { kind: 'notice', notice: { kind: 'unavailable' } };
  if (resolution.orgId === activeOrgId) return openOrStay(input.native, input.pathname);
  const org = orgs.find((o) => o.id === resolution.orgId);
  if (!org) return { kind: 'notice', notice: { kind: 'unavailable' } };
  return {
    kind: 'notice',
    notice: {
      kind: 'switch',
      orgId: org.id,
      orgName: org.name,
      activeOrgName,
      noun: targetNoun(input.routeKind),
      native: input.native,
    },
  };
}

/** What the workspace read found, for the diagnostics (never an id). */
export function resolutionReason(resolution: TargetResolution, next: OpenStep): PushOpenReason {
  if (next.kind === 'idle') return 'superseded';
  if (resolution.kind === 'error') return 'error';
  if (resolution.kind === 'none') return 'none';
  if (next.kind !== 'notice') return 'same-workspace';
  return next.notice.kind === 'switch' ? 'other-workspace' : 'not-a-member';
}

/**
 * Structural slice of the Supabase client. `from` returns `unknown` on
 * purpose (as cycle-count-lines-fetch.ts does): spelling the typed PostgREST
 * builder here makes TS instantiate it at the call site. Re-narrowed below.
 */
export interface WorkspaceResolverClient {
  from(table: string): unknown;
}

interface OrganizationRead {
  select(columns: 'organization_id'): {
    eq(
      column: 'id',
      value: string,
    ): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
}

/**
 * How long the workspace read for a tapped order or return may take
 * (orchestrator decision (a), 2026-10-13). React Native's fetch has no
 * timeout of its own (use-workspace.ts WAREHOUSE_READ_TIMEOUT_MS), and the
 * host waits for this answer, so a request that stalled (the 1-8 s IAD
 * stalls, a captive portal that never answers) left the tap with no page, no
 * notice and no Try again. A network deadline, not a readiness wait: it ends
 * a read, and never decides when a tap may open.
 */
export const TARGET_READ_TIMEOUT_MS = 15_000;

/** The class name a read past its deadline reports (errorClassOf's shape). */
const TIMEOUT_ERROR_CLASS = 'TimeoutError';

/** The read itself: under the user's own RLS, by id alone. Never rejects. */
async function readTargetOrganization(
  client: WorkspaceResolverClient,
  table: ResolveTable,
  id: string,
): Promise<TargetResolution> {
  try {
    const read = client.from(table) as OrganizationRead;
    const { data, error } = await read.select('organization_id').eq('id', id).maybeSingle();
    if (error) return { kind: 'error', errorClass: errorClassOf(error) };
    const orgId = (data as { organization_id?: unknown } | null)?.organization_id;
    return typeof orgId === 'string' && orgId ? { kind: 'found', orgId } : { kind: 'none' };
  } catch (err) {
    return { kind: 'error', errorClass: errorClassOf(err) };
  }
}

/**
 * The organization of one order or return, read under the user's own RLS by
 * id alone, bounded as use-workspace.ts loadWarehousesBounded bounds the
 * warehouse read: still out after TARGET_READ_TIMEOUT_MS, it answers as a
 * read error (the Try again notice), and its late answer goes nowhere.
 * Never rejects.
 */
export function resolveTargetWorkspace(
  client: WorkspaceResolverClient,
  table: ResolveTable,
  id: string,
): Promise<TargetResolution> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: 'error', errorClass: TIMEOUT_ERROR_CLASS });
    }, TARGET_READ_TIMEOUT_MS);
    void readTargetOrganization(client, table, id).then((resolution) => {
      clearTimeout(timer);
      resolve(resolution);
    });
  });
}

/**
 * How long a workspace read may run before the notice says it is checking
 * (orchestrator decision (b), 2026-10-13): a slow connection must never look
 * like a dead tap, and a fast read shows nothing at all. A UI delay, not a
 * readiness wait: it changes what the screen says, never when a tap opens.
 */
export const CHECKING_NOTICE_DELAY_MS = 400;

export interface WorkspaceCheckHandlers {
  /** The read is still out after CHECKING_NOTICE_DELAY_MS and its tap is
   *  still the pending one: show the Checking notice. */
  checking(): void;
  /** The read answered (its deadline is an answer too). stepAfterResolution
   *  decides what it means for the tap pending now. */
  answer(resolution: TargetResolution): void;
}

export interface WorkspaceChecks {
  /** Start the check for tap `seq`, ending any check still running. Every
   *  start is its own attempt: Try again reuses the tap's seq, not this. */
  start(seq: number, read: () => Promise<TargetResolution>, handlers: WorkspaceCheckHandlers): void;
  /** True while the check for tap `seq` has not answered. */
  running(seq: number): boolean;
  /** End the running check unless it is for tap `seq`, the one pending now
   *  (null: none). A newer tap or a sign-out ends it, timer and all. */
  keepOnly(seq: number | null): void;
  /** End the running check (an unmount): no handler runs after this. */
  cancel(): void;
}

interface RunningCheck {
  seq: number;
  attempt: number;
  /** The Checking notice's delay. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The host's workspace checks, one at a time (orchestrator decisions (a) and
 * (b)). Only the attempt still running may call a handler, so an attempt
 * that was ended or replaced (by Try again, or a newer tap's check) leaves
 * its late answer with nowhere to go. `pendingSeq` is the store's pending tap
 * (notificationIntents.peek()): the Checking notice is asked for only while
 * that is still the tap the read is for. Every read answers in the end
 * (resolveTargetWorkspace's deadline), and the answer ends the check.
 */
export function createWorkspaceChecks(pendingSeq: () => number | null): WorkspaceChecks {
  let current: RunningCheck | null = null;
  let attempts = 0;
  const end = () => {
    if (current) clearTimeout(current.timer);
    current = null;
  };
  return {
    start(seq, read, handlers) {
      end();
      attempts += 1;
      const attempt = attempts;
      const isRunning = () => current?.attempt === attempt;
      const settle = (resolution: TargetResolution) => {
        if (!isRunning()) return;
        end();
        handlers.answer(resolution);
      };
      const timer = setTimeout(() => {
        if (isRunning() && pendingSeq() === seq) handlers.checking();
      }, CHECKING_NOTICE_DELAY_MS);
      current = { seq, attempt, timer };
      void read().then(settle, (err: unknown) =>
        settle({ kind: 'error', errorClass: errorClassOf(err) }),
      );
    },
    running: (seq) => current?.seq === seq,
    keepOnly(seq) {
      if (current && current.seq !== seq) end();
    },
    cancel: end,
  };
}

// ── The notice (notification-intent-notice.tsx renders this) ──────────────

export const NOTICE_UNAVAILABLE_COPY =
  "This isn't available. It may have been removed, or it isn't shared with you.";
export const NOTICE_NO_PAGE_COPY = 'This notification has no page in the app.';
export const NOTICE_OTHER_ACCOUNT_COPY =
  'That notification was sent to a different account on this phone.';
export const NOTICE_RETRY_COPY =
  'Could not open this notification. Check your connection and try again.';

export function switchNoticeCopy(
  noun: TargetNoun,
  orgName: string,
  activeOrgName: string | null,
): string {
  return `This ${noun} is in ${orgName}. You are working in ${activeOrgName ?? 'another workspace'}.`;
}

/** While a slow workspace read is out (orchestrator decision (b)). */
export function checkingNoticeCopy(noun: TargetNoun): string {
  return `Checking which workspace this ${noun} is in.`;
}

export type NoticeActionId = 'switch' | 'not-now' | 'open-notifications' | 'close' | 'retry' | 'ok';

export interface NoticeAction {
  id: NoticeActionId;
  label: string;
  primary: boolean;
  disabled: boolean;
}

export interface NoticeContent {
  heading: string | null;
  lines: string[];
  actions: NoticeAction[];
  /** What the backdrop, Escape and the Android back button do. */
  dismiss: NoticeActionId;
  /** Read out by VoiceOver when the notice appears. */
  announcement: string;
  /** Something is under way (the workspace check): the notice shows a spinner. */
  progress: boolean;
}

const action = (
  id: NoticeActionId,
  label: string,
  primary: boolean,
  disabled = false,
): NoticeAction => ({
  id,
  label,
  primary,
  disabled,
});

function content(
  heading: string | null,
  lines: string[],
  actions: NoticeAction[],
  dismiss: NoticeActionId,
  progress = false,
): NoticeContent {
  return {
    heading,
    lines,
    actions,
    dismiss,
    announcement: [heading, ...lines].filter(Boolean).join(' '),
    progress,
  };
}

/** The words and buttons of a notice. Offline, the switch is disabled (the
 *  notice adds the drawer's WORKSPACE_SWITCH_OFFLINE_COPY beneath). */
export function noticeContent(notice: IntentNotice, opts: { offline: boolean }): NoticeContent {
  switch (notice.kind) {
    case 'account-mismatch':
      return content(null, [NOTICE_OTHER_ACCOUNT_COPY], [action('ok', 'OK', true)], 'ok');
    case 'unsupported':
      return content(
        notice.title,
        [notice.body, NOTICE_NO_PAGE_COPY].filter((line): line is string => !!line),
        [action('open-notifications', 'Open notifications', true), action('close', 'Close', false)],
        'close',
      );
    case 'unavailable':
      return content(
        null,
        [NOTICE_UNAVAILABLE_COPY],
        [action('open-notifications', 'Open notifications', true), action('close', 'Close', false)],
        'close',
      );
    case 'retry':
      return content(
        null,
        [NOTICE_RETRY_COPY],
        [action('retry', 'Try again', true), action('close', 'Close', false)],
        'close',
      );
    case 'checking':
      return content(
        null,
        [checkingNoticeCopy(notice.noun)],
        [action('close', 'Close', false)],
        'close',
        true,
      );
    case 'switch':
      return content(
        null,
        [switchNoticeCopy(notice.noun, notice.orgName, notice.activeOrgName)],
        [
          action('switch', `Switch to ${notice.orgName}`, true, opts.offline),
          action('not-now', 'Not now', false),
        ],
        'not-now',
      );
  }
}
