import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  detectExportAbuse,
  detectFailedLoginBursts,
  detectMassMutations,
  detectPasswordResetBursts,
  detectPrivilegeEscalations,
  type AuditRow,
} from '@/server/security/monitors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Look-back window. Equals the cron interval (hourly) so windows don't overlap
 *  and each audit row is evaluated exactly once — no repeat-alert spam. */
const WINDOW_MINUTES = 60;

/** PostgREST max_rows cap; mirrors server/services/lib/paginate.ts PAGE_SIZE. */
const PAGE_SIZE = 1000;

/** Default thresholds (per WINDOW_MINUTES). Tunable here as traffic grows. */
const THRESHOLDS = {
  failedLoginEmail: 8,
  failedLoginIp: 15,
  passwordReset: 5,
  privilegeEscalation: 3,
  massMutation: 25,
  exportAbuse: 3,
} as const;

/** Audit events the detectors consume — the only rows we pull. */
const WATCHED_EVENTS = [
  'user.sign_in_failed',
  'user.password.reset_requested',
  'user.role.changed',
  'inventory.item.deleted',
  'inventory.item.archived',
  'security.export_rate_limited',
] as const;

/** Constant-time secret compare. Matches cron/auth-anomalies. */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Audit-anomaly monitor (Cybersecurity Phase 2). Pulls the watched audit_logs
 * events from the last hour and runs five pure detectors over them, alerting the
 * platform #alerts feed (via reportError → ERROR_WEBHOOK_URL) for each finding:
 *   - failed-login bursts (per email / per IP) — brute force / cred stuffing
 *   - password-reset bursts (per email) — account-takeover recon
 *   - privilege escalations (per org) — role elevations to admin/owner
 *   - mass deletes/archives (per actor) — insider / compromise / accident
 *   - export abuse (per actor) — sustained data scraping
 *
 * Schedule: "0 *\/1 * * *" (hourly) — see apps/web/vercel.json.
 * Auth: Bearer ${CRON_SECRET} — fail-closed.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const rows: AuditRow[] = [];

  try {
    // Paginate — a plain .select() is silently capped at PostgREST's 1000-row
    // max, which would drop events on a busy/under-attack hour.
    for (let from = 0; ; from += PAGE_SIZE) {
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await admin
        .from('audit_logs')
        .select('event, user_id, organization_id, ip, metadata, created_at')
        .in('event', WATCHED_EVENTS as unknown as string[])
        .gte('created_at', windowStart)
        .order('id', { ascending: true })
        .range(from, to);

      if (error) {
        void reportError(new Error(`audit-anomalies query: ${error.message}`), {
          tag: 'cron.audit-anomaly',
        });
        return NextResponse.json({ error: 'query_failed' }, { status: 500 });
      }

      const page = (data ?? []) as AuditRow[];
      for (const r of page) rows.push(r);
      if (page.length < PAGE_SIZE) break;
    }

    const failedLogins = detectFailedLoginBursts(rows, {
      emailThreshold: THRESHOLDS.failedLoginEmail,
      ipThreshold: THRESHOLDS.failedLoginIp,
    });
    const passwordResets = detectPasswordResetBursts(rows, THRESHOLDS.passwordReset);
    const escalations = detectPrivilegeEscalations(rows, THRESHOLDS.privilegeEscalation);
    const massMutations = detectMassMutations(rows, THRESHOLDS.massMutation);
    const exportAbuse = detectExportAbuse(rows, THRESHOLDS.exportAbuse);

    for (const f of failedLogins.byEmail) {
      void reportError(new Error('Security anomaly: failed-login burst (account)'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'failed_login_email', email: f.email, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }
    for (const f of failedLogins.byIp) {
      void reportError(new Error('Security anomaly: failed-login burst (IP)'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'failed_login_ip', ip: f.ip, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }
    for (const f of passwordResets) {
      void reportError(new Error('Security anomaly: password-reset burst'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'password_reset', email: f.email, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }
    for (const f of escalations) {
      void reportError(new Error('Security anomaly: privilege-escalation burst'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'privilege_escalation', organizationId: f.organizationId, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }
    for (const f of massMutations) {
      void reportError(new Error('Security anomaly: mass item delete/archive'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'mass_mutation', organizationId: f.organizationId, userId: f.userId, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }
    for (const f of exportAbuse) {
      void reportError(new Error('Security anomaly: sustained export abuse'), {
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: { kind: 'export_abuse', organizationId: f.organizationId, userId: f.userId, count: f.count, windowMinutes: WINDOW_MINUTES },
      });
    }

    const flagged =
      failedLogins.byEmail.length +
      failedLogins.byIp.length +
      passwordResets.length +
      escalations.length +
      massMutations.length +
      exportAbuse.length;

    return NextResponse.json({
      windowMinutes: WINDOW_MINUTES,
      rowsScanned: rows.length,
      flagged,
      byDetector: {
        failedLoginEmail: failedLogins.byEmail.length,
        failedLoginIp: failedLogins.byIp.length,
        passwordReset: passwordResets.length,
        privilegeEscalation: escalations.length,
        massMutation: massMutations.length,
        exportAbuse: exportAbuse.length,
      },
    });
  } catch (err) {
    void reportError(err, { tag: 'cron.audit-anomaly' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
