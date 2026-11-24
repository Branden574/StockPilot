import 'server-only';

import {
  isAdminRole,
  isSecurityEventCategory,
  SECURITY_EVENT_CATEGORIES,
  type SecurityEventCategory,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import { mfaGateError, ServiceError, type ServiceContext } from './context';

/**
 * BLOCKED ACTIVITY for one organization: what the app refused that was about
 * it (sign-in, authenticator and recovery code refusals of its members), for
 * its owners and admins.
 *
 * Read through the member's own client, never the service client: the table
 * has row security with no policy and no grant to members, so the only way in
 * is the two gated functions of migration security_events,
 * security_events_for_organization and security_event_totals_for_organization.
 * Each checks the caller with has_org_role(organization, 'admin') before it
 * reads and refuses with 42501 otherwise. Neither returns the source hash or
 * the row key. They also apply the authenticator rule themselves (42501 with
 * the hint mfa_required or aal2_required).
 *
 * The gate here comes first, in the order assertPermission uses: the MFA
 * step-up (mfaGateError: a member who owes an authenticator, or whose policy
 * could not be read, is refused before anything is read), then the role
 * (owners and admins, core isAdminRole). Only then the functions, with the
 * context's own organization and nothing from the request. A 42501 from them
 * (whatever its hint) is the same forbidden answer; a statement timeout of
 * the totals alone leaves the totals out and keeps the rows; any other error
 * is reported (its code only) and answered as an internal error.
 *
 * This page sits under /dashboard/settings/security, which is open to a
 * member who still owes an authenticator (lib/auth/authenticator-set-up.ts):
 * the MFA gate above is what keeps such a member out.
 */

/** Rows the table shows, newest first. */
export const SECURITY_ACTIVITY_ROW_LIMIT = 100;

/** The totals' window: the functions' default, the last 7 days up to now. */
export const SECURITY_ACTIVITY_TOTALS_DAYS = 7;

/**
 * Kinds an organization's own Blocked activity page leaves out (part 6, stage
 * 6a): the upload checks record a refused file as malware in the
 * organization, for the platform console. This page stays as it was (its
 * words are about wrong passwords and codes), and the person who sent the
 * file was already told in a plain sentence. Showing it here is one line.
 */
export const SECURITY_ACTIVITY_HIDDEN_CATEGORIES: ReadonlySet<string> = new Set(['malware']);

export interface SecurityActivityRow {
  id: string;
  /** The start of the UTC minute the events happened in. */
  minute: string;
  /** The latest event counted on the row. */
  lastSeenAt: string;
  category: string;
  outcome: string;
  reason: string;
  source: string;
  country: string | null;
  city: string | null;
  count: number;
}

export interface SecurityActivityTotal {
  category: SecurityEventCategory;
  events: number;
}

export interface SecurityActivity {
  /**
   * Events per category over the last 7 days; a category with none is left
   * out. null when they could not be added up in time (a statement timeout:
   * an organization held at its cap for days has many rows), reported once;
   * the rows are still shown.
   */
  totals: SecurityActivityTotal[] | null;
  /** The newest rows, at most SECURITY_ACTIVITY_ROW_LIMIT. */
  rows: SecurityActivityRow[];
}

type RpcError = { code?: string | null; message?: string | null };

const FORBIDDEN_MESSAGE = 'Only owners and admins can see blocked activity.';

/** The step-up first, then the role: owners and admins only. */
export function assertMaySeeSecurityActivity(ctx: ServiceContext): void {
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw mfaGateError(ctx);
  }
  if (!isAdminRole(ctx.role)) {
    throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
  }
}

function refusal(error: RpcError, fn: string, organizationId: string): ServiceError {
  const code = error.code ?? '';
  if (code === '42501') return new ServiceError('forbidden', FORBIDDEN_MESSAGE);
  void reportError(new Error(`${fn} failed (${code || 'no code'})`), {
    tag: 'security-events.read',
    organizationId,
    extra: { code: code || null },
  });
  return new ServiceError('internal_error', `${fn} failed (${code || 'no code'})`);
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A count: a whole number from 0 up, as a number or as digits (bigint). */
function countOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^[0-9]{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function rowOf(raw: Record<string, unknown>): SecurityActivityRow | null {
  const id = text(raw.id);
  const minute = text(raw.minute);
  const category = text(raw.category);
  const outcome = text(raw.outcome);
  const reason = text(raw.reason);
  const source = text(raw.source);
  const count = countOf(raw.event_count);
  if (!id || !minute || !category || !outcome || !reason || !source || count === null) return null;
  return {
    id,
    minute,
    lastSeenAt: text(raw.last_seen_at) ?? minute,
    category,
    outcome,
    reason,
    source,
    country: text(raw.country),
    city: text(raw.city),
    count,
  };
}

export class SecurityEventsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** The page's read: totals by category for the last 7 days, and the newest rows. */
  async activity(): Promise<SecurityActivity> {
    assertMaySeeSecurityActivity(this.ctx);
    const organizationId = this.ctx.organizationId;

    const [rowsRes, totalsRes] = await Promise.all([
      this.ctx.supabase.rpc('security_events_for_organization', {
        p_organization_id: organizationId,
        p_limit: SECURITY_ACTIVITY_ROW_LIMIT,
      }),
      this.ctx.supabase.rpc('security_event_totals_for_organization', {
        p_organization_id: organizationId,
        p_from: null,
        p_to: null,
      }),
    ]);
    // A refusal from either is the answer, before any other error.
    for (const res of [rowsRes, totalsRes]) {
      if ((res.error as RpcError | null)?.code === '42501') {
        throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
      }
    }
    if (rowsRes.error) {
      throw refusal(rowsRes.error as RpcError, 'security_events_for_organization', organizationId);
    }
    let totalsUnavailable = false;
    if (totalsRes.error) {
      const totalsError = totalsRes.error as RpcError;
      if (totalsError.code !== '57014') {
        throw refusal(totalsError, 'security_event_totals_for_organization', organizationId);
      }
      // Too many rows to add up in time: the page shows the rows without
      // the totals. Reported once, by its code.
      totalsUnavailable = true;
      void reportError(new Error('security_event_totals_for_organization timed out (57014)'), {
        tag: 'security-events.read',
        organizationId,
        extra: { code: '57014' },
      });
    }

    const rows = ((rowsRes.data ?? []) as Array<Record<string, unknown>>)
      .map(rowOf)
      .filter((r): r is SecurityActivityRow => r !== null)
      .filter((r) => !SECURITY_ACTIVITY_HIDDEN_CATEGORIES.has(r.category))
      .slice(0, SECURITY_ACTIVITY_ROW_LIMIT);

    if (totalsUnavailable) return { totals: null, rows };

    const sums = new Map<SecurityEventCategory, number>();
    for (const raw of (totalsRes.data ?? []) as Array<Record<string, unknown>>) {
      const events = countOf(raw.events);
      if (!isSecurityEventCategory(raw.category) || events === null) continue;
      if (SECURITY_ACTIVITY_HIDDEN_CATEGORIES.has(raw.category)) continue;
      sums.set(raw.category, (sums.get(raw.category) ?? 0) + events);
    }
    const totals = SECURITY_EVENT_CATEGORIES.flatMap((category) => {
      const events = sums.get(category) ?? 0;
      return events > 0 ? [{ category, events }] : [];
    });

    return { totals, rows };
  }
}
