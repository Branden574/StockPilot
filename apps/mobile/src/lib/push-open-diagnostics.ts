/**
 * SANITISED DIAGNOSTICS FOR OPENING A TAPPED PUSH (Phase 3).
 *
 * The old tap handler swallowed every failure (`Linking.openURL(...).catch(()
 * => {})`), so a tap that went nowhere left no trace at all. Each stage of the
 * notification coordinator now leaves one Sentry breadcrumb (category
 * 'push.open'), plus a console line in development. A failed step (stage
 * 'error') also raises one Sentry event, at most once per launch for the
 * same failure (review 4): a breadcrumb reaches Sentry only with some later
 * event, and Sentry cannot search breadcrumbs across events.
 *
 * Only fixed keys with values from fixed enums leave the phone. Never the
 * link, a uuid, the push's title or body, a user or organization id, or a push
 * token: a value outside its enum is dropped, and errorClass is an error's
 * class name (Error.name) only, never its message. The event has a fixed
 * message, those values as tags, and only these breadcrumbs. Sentry does not
 * run on simulators (sentry.ts), so these tests are what pins the
 * sanitisation.
 */
import { Sentry } from './sentry';

export const PUSH_OPEN_STAGES = [
  'capture',
  'ignore',
  'parse',
  'wait',
  'take',
  'resolve',
  'navigate',
  'notice',
  'finish',
  'error',
  'ota-reload-deferred',
] as const;
export type PushOpenStage = (typeof PUSH_OPEN_STAGES)[number];

export const PUSH_OPEN_SOURCES = ['startup', 'listener'] as const;
export type PushOpenSource = (typeof PUSH_OPEN_SOURCES)[number];

export const PUSH_OPEN_LINK_KINDS = ['none', 'relative', 'scheme', 'https', 'other'] as const;

/** The first segment of every native route the shared table can answer
 *  (web-path-rewrite.ts); push-open-diagnostics.test.ts keeps them in step. */
export const PUSH_OPEN_ROUTE_KINDS = [
  'order',
  'returns',
  'item',
  'staging',
  'inventory',
  'po',
  'purchase-orders',
  'cycle-count',
  'bundles',
  'schedule',
  'notifications',
  'support',
  'orders',
  'admin',
  'maintenance',
  'exceptions',
  'rentals',
  'location',
  'locations',
  'reports',
] as const;

export const PUSH_OPEN_REASONS = [
  // The link (notification-link.ts).
  'no-link',
  'not-a-string',
  'too-long',
  'bad-scheme',
  'foreign-host',
  'malformed',
  'not-dashboard',
  'unsupported',
  'bad-id',
  // Capture (notification-intent.ts).
  'not-default-action',
  'duplicate',
  'older',
  'unavailable',
  'listener-unavailable',
  'clear-unavailable',
  'dismiss-unavailable',
  // Binding and take.
  'binding',
  'account-mismatch',
  'expired',
  'unbound',
  'ready',
  // Waits (notification-open.ts).
  'mfa-pending',
  'router-not-ready',
  'no-segments',
  'auth-group',
  'route-settling',
  'signed-out',
  'workspace-loading',
  // The workspace check.
  'found',
  'none',
  'error',
  'same-workspace',
  'other-workspace',
  'not-a-member',
  'superseded',
  // Notices.
  'switch',
  'retry',
  'checking',
  // How a tap ended.
  'navigated',
  'already-there',
  'not-now',
  'closed',
  'ok',
  'open-inbox',
  'switched',
  'switch-failed',
  'deliberate-sign-out',
  'evicted',
] as const;
export type PushOpenReason = (typeof PUSH_OPEN_REASONS)[number];

export interface PushOpenEvent {
  stage: PushOpenStage;
  source?: PushOpenSource;
  linkKind?: (typeof PUSH_OPEN_LINK_KINDS)[number];
  routeKind?: string;
  reason?: PushOpenReason;
  /** An error's class name; see errorClassOf. */
  errorClass?: string;
}

/** What an error class name may look like: 'TypeError', 'PostgrestError'. */
const SAFE_ERROR_CLASS = /^[A-Z][A-Za-z0-9]{0,40}Error$/;

/** An error's class name (Error.name) when it is a plain class name, else
 *  'Error'. Never the message. */
export function errorClassOf(err: unknown): string {
  let name: unknown = null;
  if (err instanceof Error) name = err.name;
  else if (typeof err === 'object' && err !== null) name = (err as { name?: unknown }).name;
  return typeof name === 'string' && SAFE_ERROR_CLASS.test(name) ? name : 'Error';
}

function member<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/**
 * The event as it may leave the phone: the allowlisted keys only, each value
 * in its enum (errorClass collapses to 'Error' instead). Null when the stage
 * itself is unknown: then nothing is sent.
 */
export function sanitizePushOpenEvent(
  event: Record<string, unknown>,
): Record<string, string> | null {
  if (!member(PUSH_OPEN_STAGES, event.stage)) return null;
  const out: Record<string, string> = { stage: event.stage };
  if (member(PUSH_OPEN_SOURCES, event.source)) out.source = event.source;
  if (member(PUSH_OPEN_LINK_KINDS, event.linkKind)) out.linkKind = event.linkKind;
  if (member(PUSH_OPEN_ROUTE_KINDS, event.routeKind)) out.routeKind = event.routeKind;
  if (member(PUSH_OPEN_REASONS, event.reason)) out.reason = event.reason;
  if (event.errorClass !== undefined) {
    out.errorClass =
      typeof event.errorClass === 'string' && SAFE_ERROR_CLASS.test(event.errorClass)
        ? event.errorClass
        : 'Error';
  }
  return out;
}

/** The breadcrumbs' category, and the event's tag prefix. */
const PUSH_OPEN_CATEGORY = 'push.open';

/** The fixed message of the event a failed step raises: one Sentry issue per
 *  reason (its fingerprint), found by this text or the push.open.* tags. */
export const PUSH_OPEN_ERROR_MESSAGE = 'push.open error';

/** The failures this launch (this JS runtime) has already reported. */
const reportedThisLaunch = new Set<string>();

/**
 * A failed step as one Sentry event (review 4), at most once per launch for
 * the same failure, so one that repeats on every tap (a native function this
 * build lacks) cannot flood the project. The tags are the sanitised values.
 * Only this module's breadcrumbs travel with it: the session's others
 * (request URLs, console lines, from JS or native) can name records, so a
 * filter on the event's own scope takes them off. Scope filters run after
 * every other processor (@sentry/core prepareEvent), the native breadcrumbs
 * merge included.
 */
function reportFailure(data: Record<string, string>): void {
  const key = JSON.stringify(data);
  if (reportedThisLaunch.has(key)) return;
  reportedThisLaunch.add(key);
  const tags: Record<string, string> = {};
  for (const [name, value] of Object.entries(data)) tags[`${PUSH_OPEN_CATEGORY}.${name}`] = value;
  Sentry.withScope((scope) => {
    scope.addEventProcessor((sent) => ({
      ...sent,
      breadcrumbs: (sent.breadcrumbs ?? []).filter((b) => b.category === PUSH_OPEN_CATEGORY),
    }));
    Sentry.captureMessage(PUSH_OPEN_ERROR_MESSAGE, {
      level: 'warning',
      tags,
      fingerprint: [PUSH_OPEN_CATEGORY, data.reason ?? 'error'],
    });
  });
}

/** One sanitised breadcrumb, and for a failed step one event. Never throws:
 *  a diagnostic must not break a tap. */
export function pushOpenDiag(event: PushOpenEvent): void {
  const data = sanitizePushOpenEvent(event as unknown as Record<string, unknown>);
  if (!data) return;
  try {
    Sentry.addBreadcrumb({ category: PUSH_OPEN_CATEGORY, level: 'info', data });
  } catch {
    // Diagnostics are best-effort.
  }
  if (data.stage === 'error') {
    try {
      reportFailure(data);
    } catch {
      // Diagnostics are best-effort.
    }
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[push.open]', data);
}
