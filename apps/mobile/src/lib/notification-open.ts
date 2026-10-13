/**
 * WHAT TO DO WITH A CAPTURED TAP, STEP BY STEP (Phase 3, iPhone push tap).
 *
 * Pure: NotificationIntentHost feeds it today's signals and does what it
 * answers. The order of the checks is the design:
 *
 *   1. nothing pending: idle;
 *   2. wait while MFA is still being checked after a password sign-in
 *      (mfaPending), while the navigator is not mounted, while there is no
 *      route, or while the sign-in group is still showing (the redirect to
 *      Home has not run yet);
 *   3. wait while whose tap it is is still being read;
 *   4. a tap for another account: the neutral notice; expired or unbound:
 *      dropped silently;
 *   5. a link the app cannot open: the notice with the push's own words;
 *   6. wait while the workspace is loading;
 *   7. an order or a return, for a user in more than one workspace: read its
 *      organization first (resolveTargetWorkspace);
 *   8. otherwise open it, unless it is already the screen in front.
 *
 * No timers anywhere: every wait ends on a signal the host re-renders on.
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
import { errorClassOf } from './push-open-diagnostics';

export type OpenWaitReason =
  | 'mfa-pending'
  | 'router-not-ready'
  | 'no-segments'
  | 'auth-group'
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

export type IntentNotice =
  | { kind: 'account-mismatch' }
  | { kind: 'unsupported'; title: string | null; body: string | null }
  | { kind: 'unavailable' }
  | { kind: 'retry' }
  | {
      kind: 'switch';
      orgId: string;
      orgName: string;
      activeOrgName: string | null;
      noun: 'order' | 'return';
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
  segments: readonly string[];
  pathname: string;
  workspace: WorkspaceView;
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
  if (!input.routerReady) return { kind: 'wait', reason: 'router-not-ready' };
  if (input.segments.length === 0) return { kind: 'wait', reason: 'no-segments' };
  if (input.segments[0] === '(auth)') return { kind: 'wait', reason: 'auth-group' };
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
  const { resolution, workspace } = input;
  if (resolution.kind === 'error') return { kind: 'notice', notice: { kind: 'retry' } };
  // Missing and not shared look the same under RLS, and say the same.
  if (resolution.kind === 'none') return { kind: 'notice', notice: { kind: 'unavailable' } };
  if (resolution.orgId === workspace.activeOrgId) return openOrStay(input.native, input.pathname);
  const org = workspace.orgs.find((o) => o.id === resolution.orgId);
  if (!org) return { kind: 'notice', notice: { kind: 'unavailable' } };
  return {
    kind: 'notice',
    notice: {
      kind: 'switch',
      orgId: org.id,
      orgName: org.name,
      activeOrgName: workspace.activeOrgName,
      noun: input.routeKind === 'returns' ? 'return' : 'order',
      native: input.native,
    },
  };
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
 * The organization of one order or return, read under the user's own RLS by
 * id alone. Never rejects.
 */
export async function resolveTargetWorkspace(
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

// ── The notice (notification-intent-notice.tsx renders this) ──────────────

export const NOTICE_UNAVAILABLE_COPY =
  "This isn't available. It may have been removed, or it isn't shared with you.";
export const NOTICE_NO_PAGE_COPY = 'This notification has no page in the app.';
export const NOTICE_OTHER_ACCOUNT_COPY =
  'That notification was sent to a different account on this phone.';
export const NOTICE_RETRY_COPY =
  'Could not open this notification. Check your connection and try again.';

export function switchNoticeCopy(
  noun: 'order' | 'return',
  orgName: string,
  activeOrgName: string | null,
): string {
  return `This ${noun} is in ${orgName}. You are working in ${activeOrgName ?? 'another workspace'}.`;
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
): NoticeContent {
  return {
    heading,
    lines,
    actions,
    dismiss,
    announcement: [heading, ...lines].filter(Boolean).join(' '),
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
