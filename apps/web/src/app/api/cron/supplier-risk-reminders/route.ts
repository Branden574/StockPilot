import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  SUPPLIER_RISK_REMINDER_LINK,
  SUPPLIER_RISK_REMINDER_TYPE,
  supplierRiskReminderWords,
} from '@/lib/supplier-risk/reminder-words';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { secretsEqual } from '@/server/services/lib/system-context';
import { createNotification } from '@/server/services/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The hard limit, far above the run's own deadline below. */
export const maxDuration = 300;

/** The run stops taking new rows after this (CONTRACT.md 7.2: 4 minutes). */
const RUN_DEADLINE_MS = 240_000;
/** Rows per read of supplier_risk_reminders_due (CONTRACT.md 7.2). */
const PAGE_LIMIT = 100;
/** The function's own most: asked once when a full page held nothing new. */
const WIDE_PAGE_LIMIT = 500;
/** At most this many reads in one run (CONTRACT.md 7.2). */
const MAX_PAGES = 20;
/** Tries of the confirmation after a send (never of the send). */
const CONFIRM_TRIES = 3;
const CONFIRM_WAIT_MS = [0, 250, 1000] as const;

interface DueRow {
  review_id: string;
  organization_id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  kind: 'due' | 'due_soon';
  attempt: number;
  next_review_on: string;
  org_today: string;
  admin_user_ids: string[];
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function dueRowOf(raw: unknown): DueRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.review_id) || !isString(r.organization_id)) return null;
  if (r.kind !== 'due' && r.kind !== 'due_soon') return null;
  if (!isString(r.next_review_on) || !isString(r.org_today)) return null;
  return {
    review_id: r.review_id,
    organization_id: r.organization_id,
    supplier_id: isString(r.supplier_id) ? r.supplier_id : null,
    supplier_name: typeof r.supplier_name === 'string' ? r.supplier_name : null,
    kind: r.kind,
    attempt: typeof r.attempt === 'number' ? r.attempt : 1,
    next_review_on: r.next_review_on.slice(0, 10),
    org_today: r.org_today.slice(0, 10),
    admin_user_ids: Array.isArray(r.admin_user_ids)
      ? [...new Set(r.admin_user_ids.filter(isString))]
      : [],
  };
}

const wait = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * VENDOR REVIEW REMINDERS (part 7 of the security tools; daily at 17:00 UTC,
 * vercel.json). In the shape of maintenance-draft-reminders: the cron secret
 * (fail closed: no secret set is no run), the Suppliers module checked per
 * organization from its explicit enabled row (a crons rule: never the comp
 * flag's grant), a try/catch per row, and its own deadline.
 *
 * THE ORDER, per row (CONTRACT.md 7.2, REVIEW-0481 round 2 follow-up 4):
 *   1. CLAIM FIRST: supplier_risk_reminder_claim(review_id, kind) stamps the
 *      reminder and answers true for exactly one caller, so two overlapping
 *      runs send it once. Nothing is sent unless it answers true. A claim
 *      that raises (55P03, a lock held past 2 s) is skipped for this run and
 *      never retried in a loop.
 *   2. SEND: an in-app notice (createNotification, whose database trigger
 *      pushes) to each of the organization's current owners and admins
 *      (admin_user_ids; createNotification checks each is still a current
 *      member). Link: the risk register.
 *   3. CONFIRM (the due reminder only): supplier_risk_due_reminder_sent. A
 *      confirmation that fails is tried again, up to CONFIRM_TRIES; the send
 *      is NEVER repeated. A due reminder that reached nobody, or whose
 *      confirmation never got through, stays unconfirmed: the database offers
 *      it once more 24 hours later (attempt 2), and after that the register
 *      says it could not be sent.
 *
 * A row of an organization with the module off is not claimed, so it is sent
 * when the module is turned on again.
 *
 * THE LOOP stops when a read comes back empty, after MAX_PAGES reads, at the
 * deadline, or when a read holds no row this run has not already handled (a
 * claim that raised, or a module that is off, leaves its row due). When a full
 * page held nothing new, the read is asked once more at the function's most
 * (500 rows), so such rows cannot hide the rest.
 *
 * Every database call is the service role's (createAdminClient): the three
 * job functions are granted to service_role only.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_DEADLINE_MS;
  const admin = createAdminClient();

  // The organizations with the Suppliers module on, from their explicit
  // enabled rows, read before anything is claimed. A failed read claims
  // nothing and sends nothing.
  let enabled: Set<string>;
  try {
    const rows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'suppliers')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
    enabled = new Set(rows.map((r) => r.organization_id));
  } catch (e) {
    void reportError(e, { tag: 'cron.supplier-risk-reminders' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  const counts = {
    remindersSent: 0,
    confirmed: 0,
    notConfirmed: 0,
    reachedNobody: 0,
    claimsLost: 0,
    claimsFailed: 0,
    moduleOff: 0,
  };
  let stoppedBy: 'empty' | 'last_page' | 'nothing_new' | 'pages' | 'deadline' | 'read_failed' =
    'pages';
  const seen = new Set<string>();
  let limit = PAGE_LIMIT;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() >= deadlineAt) {
      stoppedBy = 'deadline';
      break;
    }
    let read: { data: unknown; error: { code?: string | null } | null };
    try {
      read = await admin.rpc('supplier_risk_reminders_due', { p_limit: limit });
    } catch {
      read = { data: null, error: { code: 'threw' } };
    }
    if (read.error || !Array.isArray(read.data)) {
      void reportError(
        new Error(`supplier_risk_reminders_due failed (${read.error?.code || 'not a list'})`),
        {
          tag: 'cron.supplier-risk-reminders',
          extra: { code: read.error?.code ?? null, page },
        },
      );
      stoppedBy = 'read_failed';
      break;
    }
    const answered = read.data as unknown[];
    const rows = answered.map(dueRowOf).filter((r): r is DueRow => r !== null);
    if (answered.length === 0) {
      stoppedBy = 'empty';
      break;
    }
    const fresh = rows.filter((r) => !seen.has(`${r.review_id}:${r.kind}:${r.attempt}`));
    if (fresh.length === 0) {
      if (answered.length >= limit && limit < WIDE_PAGE_LIMIT) {
        limit = WIDE_PAGE_LIMIT;
        continue;
      }
      stoppedBy = 'nothing_new';
      break;
    }

    for (const row of fresh) {
      seen.add(`${row.review_id}:${row.kind}:${row.attempt}`);
      if (Date.now() >= deadlineAt) {
        stoppedBy = 'deadline';
        break;
      }
      try {
        if (!enabled.has(row.organization_id)) {
          counts.moduleOff++;
          continue;
        }

        // 1. CLAIM FIRST.
        const claim = await admin.rpc('supplier_risk_reminder_claim', {
          p_review_id: row.review_id,
          p_kind: row.kind,
        });
        if (claim.error) {
          counts.claimsFailed++;
          void reportError(
            new Error(`supplier_risk_reminder_claim failed (${claim.error.code || 'no code'})`),
            {
              tag: 'cron.supplier-risk-reminders',
              organizationId: row.organization_id,
              extra: { code: claim.error.code ?? null, reviewId: row.review_id, kind: row.kind },
            },
          );
          continue;
        }
        if (claim.data !== true) {
          counts.claimsLost++;
          continue;
        }

        // 2. SEND, once, to each owner and admin.
        const words = supplierRiskReminderWords({
          kind: row.kind,
          supplierName: row.supplier_name,
          nextReviewOn: row.next_review_on,
          orgToday: row.org_today,
        });
        let delivered = 0;
        for (const userId of row.admin_user_ids) {
          const id = await createNotification({
            organizationId: row.organization_id,
            userId,
            type: SUPPLIER_RISK_REMINDER_TYPE,
            title: words.title,
            body: words.body,
            link: SUPPLIER_RISK_REMINDER_LINK,
            metadata: {
              review_id: row.review_id,
              supplier_id: row.supplier_id,
              kind: row.kind,
              attempt: row.attempt,
            },
          });
          if (typeof id === 'string') delivered++;
        }
        if (delivered === 0) {
          // Nobody was told: the due reminder stays unconfirmed, so the
          // database offers it once more (and then the register says so).
          counts.reachedNobody++;
          void reportError(new Error('supplier risk reminder reached nobody'), {
            tag: 'cron.supplier-risk-reminders',
            level: 'warning',
            organizationId: row.organization_id,
            extra: { reviewId: row.review_id, kind: row.kind, admins: row.admin_user_ids.length },
          });
          continue;
        }
        counts.remindersSent++;

        // 3. CONFIRM the due reminder: the confirmation is tried again, never the send.
        if (row.kind === 'due') {
          if (await confirmSent(admin, row)) counts.confirmed++;
          else counts.notConfirmed++;
        }
      } catch (e) {
        void reportError(e, {
          tag: 'cron.supplier-risk-reminders',
          organizationId: row.organization_id,
          extra: { reviewId: row.review_id, kind: row.kind },
        });
      }
    }
    if (stoppedBy === 'deadline') break;
    if (answered.length < limit) {
      stoppedBy = 'last_page';
      break;
    }
  }

  // A run that ended before the database ran out of due rows is partial.
  const partial = stoppedBy === 'deadline' || stoppedBy === 'pages' || stoppedBy === 'nothing_new';
  if (partial) {
    void reportError(new Error(`Vendor review reminders stopped early (${stoppedBy})`), {
      tag: 'cron.supplier-risk-reminders.stopped',
      level: 'warning',
      extra: { stoppedBy, sent: counts.remindersSent },
    });
  }
  const status = stoppedBy === 'read_failed' ? 500 : 200;
  return NextResponse.json({ ok: status === 200, partial, stoppedBy, ...counts }, { status });
}

/**
 * supplier_risk_due_reminder_sent, tried up to CONFIRM_TRIES times when the
 * call fails (an error or a throw). An answer of false is no failure: the
 * reminder was already confirmed. True when an answer came back.
 */
async function confirmSent(
  admin: ReturnType<typeof createAdminClient>,
  row: DueRow,
): Promise<boolean> {
  let lastCode: string | null = null;
  for (let attempt = 0; attempt < CONFIRM_TRIES; attempt++) {
    await wait(CONFIRM_WAIT_MS[attempt] ?? 1000);
    try {
      const confirm = await admin.rpc('supplier_risk_due_reminder_sent', {
        p_review_id: row.review_id,
      });
      if (!confirm.error) return true;
      lastCode = confirm.error.code ?? 'no code';
    } catch {
      lastCode = 'threw';
    }
  }
  void reportError(new Error(`supplier_risk_due_reminder_sent failed (${lastCode})`), {
    tag: 'cron.supplier-risk-reminders.confirm',
    organizationId: row.organization_id,
    extra: { code: lastCode, reviewId: row.review_id, tries: CONFIRM_TRIES },
  });
  return false;
}
