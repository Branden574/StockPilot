import 'server-only';

import { isAdminRole } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

import { mfaGateError, ServiceError, type ServiceContext } from './context';

/**
 * SIGN-IN ALERTS (part 3 of the security tools): the reads of the alerts and
 * the member's "This was me". The "This was not me" report is
 * server/services/sign-in-alert-report.ts.
 *
 * THE ORGANIZATION'S LIST (owners and admins). Read through the member's own
 * client, never the service client: sign_in_alerts has row security with no
 * policy and no grant to members, so the only way in is the gated function
 * sign_in_alerts_for_organization, which checks has_org_role(organization,
 * 'admin') and the authenticator rule itself (42501). The gate here comes
 * first, in the order Blocked activity uses (server/services/security-events.ts):
 * the authenticator step (mfaGateError), then the role. Only then the
 * function, with the context's own organization and nothing from the request.
 * It names the device FAMILY ("Chrome on macOS"), never the member's own
 * label, the device row or the session.
 *
 * THE MEMBER'S OWN ALERTS. my_sign_in_alerts(), through the member's own
 * client: the last 30 days, at most 50, with the member's own device words.
 * It refuses (42501) a disabled account and an account with an authenticator
 * at a password-only session. Any role may read their own.
 *
 * "THIS WAS ME". Refused while the session still owes the authenticator step
 * (a password alone must not be enough to quiet an alert), then ONE update,
 * with the service role, of the member's own alert while it is still open:
 * the answer and its resolved_at together, as the table requires. An alert
 * already answered, or not the member's, changes nothing and gets the same
 * 'unchanged' answer.
 */

/**
 * Rows the organization's list asks for, newest first: the most
 * sign_in_alerts_for_organization gives (500). One account can write up to
 * 50 alert rows a day, so a shorter page could be filled by one member and
 * push everyone else's alerts off it (review 2, finding 3). The page says so
 * when it shows this many.
 */
export const SIGN_IN_ALERTS_ROW_LIMIT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SignInAlertStatus = 'open' | 'was_me' | 'not_me';

/** One alert as the organization's owners and admins see it. */
export interface OrganizationSignInAlert {
  id: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  newDevice: boolean;
  newCountry: boolean;
  client: 'web' | 'phone';
  deviceFamily: string;
  country: string | null;
  city: string | null;
  status: SignInAlertStatus;
  resolvedAt: string | null;
  createdAt: string;
}

/** One of the member's own alerts. */
export interface MySignInAlert {
  id: string;
  sessionId: string | null;
  newDevice: boolean;
  newCountry: boolean;
  client: 'web' | 'phone';
  deviceLabel: string;
  country: string | null;
  city: string | null;
  status: SignInAlertStatus;
  createdAt: string;
}

type RpcError = { code?: string | null };

const FORBIDDEN_MESSAGE = 'Only owners and admins can see sign-in alerts.';

/** The step-up first, then the role: owners and admins only. */
export function assertMaySeeSignInAlerts(ctx: ServiceContext): void {
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw mfaGateError(ctx);
  }
  if (!isAdminRole(ctx.role)) {
    throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function statusOf(v: unknown): SignInAlertStatus | null {
  return v === 'open' || v === 'was_me' || v === 'not_me' ? v : null;
}

function organizationRowOf(raw: Record<string, unknown>): OrganizationSignInAlert | null {
  const id = text(raw.id);
  const userId = text(raw.user_id);
  const status = statusOf(raw.status);
  const createdAt = text(raw.created_at);
  if (!id || !userId || !status || !createdAt) return null;
  return {
    id,
    userId,
    fullName: text(raw.full_name),
    email: text(raw.email),
    newDevice: raw.new_device === true,
    newCountry: raw.new_country === true,
    client: raw.client === 'phone' ? 'phone' : 'web',
    deviceFamily: text(raw.device_family) ?? 'Unknown device',
    country: text(raw.country),
    city: text(raw.city),
    status,
    resolvedAt: text(raw.resolved_at),
    createdAt,
  };
}

function myRowOf(raw: Record<string, unknown>): MySignInAlert | null {
  const id = text(raw.id);
  const status = statusOf(raw.status);
  const createdAt = text(raw.created_at);
  if (!id || !status || !createdAt) return null;
  return {
    id,
    sessionId: text(raw.session_id),
    newDevice: raw.new_device === true,
    newCountry: raw.new_country === true,
    client: raw.client === 'phone' ? 'phone' : 'web',
    deviceLabel: text(raw.device_label) ?? 'Unknown device',
    country: text(raw.country),
    city: text(raw.city),
    status,
    createdAt,
  };
}

function report(fn: string, code: string | null, organizationId?: string): void {
  void reportError(new Error(`${fn} failed (${code || 'no code'})`), {
    tag: 'sign-in-alerts.read',
    ...(organizationId ? { organizationId } : {}),
    extra: { code: code || null },
  });
}

export class SignInAlertsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** The organization's list: the newest SIGN_IN_ALERTS_ROW_LIMIT alerts of its members. */
  async forOrganization(): Promise<OrganizationSignInAlert[]> {
    assertMaySeeSignInAlerts(this.ctx);
    const organizationId = this.ctx.organizationId;
    const { data, error } = await this.ctx.supabase.rpc('sign_in_alerts_for_organization', {
      p_organization_id: organizationId,
      p_limit: SIGN_IN_ALERTS_ROW_LIMIT,
    });
    if (error) {
      const code = (error as RpcError).code ?? null;
      if (code === '42501') throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
      report('sign_in_alerts_for_organization', code, organizationId);
      throw new ServiceError('internal_error', `sign_in_alerts_for_organization failed (${code || 'no code'})`);
    }
    if (!Array.isArray(data)) {
      // An answer that is not a list is a failed read, never "no alerts".
      report('sign_in_alerts_for_organization', 'not_a_list', organizationId);
      throw new ServiceError('internal_error', 'sign_in_alerts_for_organization answered without a list');
    }
    return (data as Array<Record<string, unknown>>)
      .map(organizationRowOf)
      .filter((r): r is OrganizationSignInAlert => r !== null)
      .slice(0, SIGN_IN_ALERTS_ROW_LIMIT);
  }

  /** The member's own alerts of the last 30 days, or null when they could not be read. */
  async mine(): Promise<MySignInAlert[] | null> {
    try {
      const { data, error } = await this.ctx.supabase.rpc('my_sign_in_alerts');
      if (error || !Array.isArray(data)) {
        const code = (error as RpcError | null)?.code ?? null;
        if (code !== '42501') report('my_sign_in_alerts', code);
        return null;
      }
      return (data as Array<Record<string, unknown>>)
        .map(myRowOf)
        .filter((r): r is MySignInAlert => r !== null);
    } catch {
      report('my_sign_in_alerts', null);
      return null;
    }
  }

  /** "This was me": the member's own open alert becomes was_me. */
  async confirm(alertId: string): Promise<'confirmed' | 'unchanged'> {
    if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) {
      throw mfaGateError(this.ctx);
    }
    if (typeof alertId !== 'string' || !UUID.test(alertId)) {
      throw new ServiceError('not_found', 'That sign-in alert was not found.');
    }
    const { data, error } = await createAdminClient()
      .from('sign_in_alerts')
      .update({ status: 'was_me', resolved_at: new Date().toISOString() })
      .eq('id', alertId.toLowerCase())
      .eq('user_id', this.ctx.userId)
      .eq('status', 'open')
      .select('id');
    if (error || !Array.isArray(data)) {
      const code = (error as RpcError | null)?.code ?? null;
      void reportError(new Error(`sign_in_alerts confirm failed (${code || 'no code'})`), {
        tag: 'sign-in-alerts.confirm',
        extra: { code: code || null },
      });
      throw new ServiceError('internal_error', `sign_in_alerts confirm failed (${code || 'no code'})`);
    }
    return data.length > 0 ? 'confirmed' : 'unchanged';
  }
}
