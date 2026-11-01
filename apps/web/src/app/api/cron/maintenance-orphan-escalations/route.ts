import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  findUnlinkedEscalationRequests,
  incompleteRunAlert,
  runReport,
  unlinkedRequestsAlert,
  type UnlinkedEscalationScan,
} from '@/server/services/escalation-orphans';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit (Vercel stops the invocation, uncatchably, at this many
 * seconds). Far above ORPHAN_SWEEP.deadlineMs (45 s), as for the
 * exception-occurrences cron, because the deadline only stops organizations
 * from STARTING: the ones in flight still finish their reads, and
 * Vercel-to-Supabase calls stall for 1 to 8 s at times. Stopped at 60 s, a
 * run would end without its alerts, including the one that says it did not
 * finish.
 */
export const maxDuration = 300;

/**
 * UNLINKED ESCALATION REQUESTS, once a day (vercel.json; ORPHAN_SWEEP in
 * server/services/escalation-orphans.ts says what is found and why).
 *
 * The F1-5 runbook query (requests an escalation saved but never linked to
 * its exception), scheduled, and read for each organization on its own. The
 * run sends at most two alerts to the platform's alerts channel, with what a
 * person needs in the text (a Slack webhook gets the text alone):
 * - one warning (tag exceptions.escalate_orphan_detected, the channel the
 *   escalation's own failures report to) listing the unlinked requests by
 *   handle, EX reference, request id and organization id, so a person can
 *   tell each requester, who may cancel it;
 * - one error (tag cron.maintenance-orphan-escalations.incomplete) when the
 *   run did not read everything: each organization that reached its cap,
 *   with how many it read and where its read stopped, and any organization
 *   not reached before the deadline.
 * One alert for all the requests, not one each: Slack takes about one
 * message a second from a webhook, and reportError does not read the
 * answer, so a burst would be lost without a trace. It writes nothing.
 *
 * CRON_SECRET-gated (constant-time compare), FAILING CLOSED when the secret
 * is unset. A failed read in any organization answers 500 and alerts nothing
 * about requests: a failed link read would make every request look
 * unlinked, and a skipped organization would look like a quiet one.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let scan: UnlinkedEscalationScan;
  try {
    scan = await findUnlinkedEscalationRequests(createAdminClient(), Date.now());
  } catch (err) {
    await reportError(err, { tag: 'cron.maintenance-orphan-escalations' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // Awaited one after the other, not fire-and-forget: the alerts are this
  // run's whole output, and a function can be frozen once it has answered.
  // reportError never throws.
  const unlinked = unlinkedRequestsAlert(scan.orphans);
  if (unlinked) {
    await reportError(runReport(unlinked.message), {
      tag: 'exceptions.escalate_orphan_detected',
      level: 'warning',
      extra: { orphans: scan.orphans.length, listed: unlinked.listed },
    });
  }
  const incomplete = incompleteRunAlert(scan);
  if (incomplete) {
    await reportError(runReport(incomplete), {
      tag: 'cron.maintenance-orphan-escalations.incomplete',
      level: 'error',
      extra: { capped: scan.capped.length, notRead: scan.notRead.length },
    });
  }

  const summary = {
    ok: true,
    complete: scan.capped.length === 0 && scan.notRead.length === 0,
    organizations: scan.organizations,
    read: scan.read,
    candidates: scan.candidates,
    orphans: scan.orphans.length,
    reported: unlinked?.listed ?? 0,
    capped: scan.capped,
    notRead: scan.notRead,
  };
  // One line per run: counts, and each capped organization by id with its
  // count and where its read stopped. The organizations not read are only
  // counted here (the alert and the answer name them).
  console.info(
    '[cron.maintenance-orphan-escalations]',
    JSON.stringify({ ...summary, notRead: scan.notRead.length }),
  );

  return NextResponse.json(summary);
}
