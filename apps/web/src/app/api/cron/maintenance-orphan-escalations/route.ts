import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { findUnlinkedEscalationRequests, ORPHAN_SWEEP } from '@/server/services/escalation-orphans';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * UNLINKED ESCALATION REQUESTS, once a day (vercel.json; ORPHAN_SWEEP in
 * server/services/escalation-orphans.ts says what is found and why).
 *
 * The F1-5 runbook query (requests an escalation saved but never linked to
 * its exception), scheduled. Each one found is an alert to the platform's
 * alerts channel (reportError, tag exceptions.escalate_orphan_detected, the
 * same channel the escalation's own failures report to), naming the request
 * by id and handle and its exception by EX reference, so a person can tell
 * the requester, who may cancel it. It writes nothing.
 *
 * CRON_SECRET-gated (constant-time compare), FAILING CLOSED when the secret
 * is unset. A failed read answers 500 and alerts nothing about requests: a
 * failed link read would make every request look unlinked.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let scan;
  try {
    scan = await findUnlinkedEscalationRequests(createAdminClient(), Date.now());
  } catch (err) {
    await reportError(err, { tag: 'cron.maintenance-orphan-escalations' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // Awaited, not fire-and-forget: the alerts are this run's whole output, and
  // a function can be frozen once it has answered. reportError never throws.
  const reported = scan.orphans.slice(0, ORPHAN_SWEEP.maxReports);
  await Promise.all(
    reported.map((o) =>
      reportError(
        new Error('An exception escalation saved a maintenance request that no exception links'),
        {
          tag: 'exceptions.escalate_orphan_detected',
          level: 'warning',
          organizationId: o.organizationId,
          extra: {
            requestId: o.id,
            reference: o.reference,
            exceptionReference: o.exceptionReference,
            createdAt: o.createdAt,
          },
        },
      ),
    ),
  );
  const notReported = scan.orphans.length - reported.length;
  if (notReported > 0) {
    await reportError(new Error('More unlinked escalation requests than one run alerts for'), {
      tag: 'cron.maintenance-orphan-escalations.more',
      level: 'warning',
      extra: { notReported },
    });
  }
  if (scan.truncated) {
    await reportError(
      new Error('The unlinked escalation check reached its read bound; there may be more'),
      {
        tag: 'cron.maintenance-orphan-escalations.truncated',
        level: 'warning',
        extra: { candidates: scan.candidates, bound: ORPHAN_SWEEP.maxCandidates },
      },
    );
  }

  // One line per run, counts only.
  console.info(
    '[cron.maintenance-orphan-escalations]',
    JSON.stringify({
      candidates: scan.candidates,
      truncated: scan.truncated,
      orphans: scan.orphans.length,
      reported: reported.length,
    }),
  );

  return NextResponse.json({
    ok: true,
    candidates: scan.candidates,
    orphans: scan.orphans.length,
    reported: reported.length,
  });
}
