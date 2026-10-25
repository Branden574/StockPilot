import 'server-only';

import { formatMaintenanceRequestNumber } from '@stockpilot/core';

import type { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { mapIdBatches, rawErrorText } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';

/**
 * Maintenance requests an exception escalation SAVED but never LINKED (F1-5,
 * migration 0376), found after the fact.
 *
 * Escalating creates the request (MaintenanceRequestsService.create) and then
 * links it (exception_escalation_finish). ExceptionEscalationService reports
 * three ways the two can come apart while it is running (a lost insert
 * answer, a lost finish answer, a cancel that failed), each with the request
 * id. A fourth reports nothing: the web process dies between the insert and
 * the finish. The occurrence's claim then frees itself after 2 minutes, so
 * the exception can be escalated again, and the first request stays live,
 * linked to nothing; its requester was never told it exists.
 *
 * This is the read the F1-5 runbook ran by hand, scheduled
 * (cron/maintenance-orphan-escalations): a live request (not cancelled,
 * archived or resolved) whose description still carries the prefill's
 * "Ref EX-<number>" and that no exception_occurrences row links. A request
 * someone wrote by hand with "Ref EX-" in it matches too (rare), which is why
 * the alert asks a person to look rather than anything being changed: the
 * runbook's answer is to tell the requester, who can cancel it. Nothing here
 * writes, and nothing is ever cancelled on anyone's behalf.
 *
 * Each organization is read on its own, under its own cap
 * (ORPHAN_SWEEP.maxCandidatesPerOrg), never in one read across
 * organizations: any member can type "Ref EX-" into a request, so a bound
 * shared by every organization let one organization's requests fill it and
 * hide another organization's real unlinked request for as long as they
 * stayed in the window. An organization that reaches its cap, and any the
 * run did not reach before its deadline, are named in one error alert, so a
 * flood is told apart from a quiet day.
 *
 * Every organization is read (the organizations table), not only those with
 * the maintenance module on: a request outlives its module being turned off,
 * and a module turned off mid-escalation is one way a request is left
 * unlinked (the escalation's cancel of a refused link needs the module). An
 * organization with nothing in the window costs one read of
 * maintenance_requests_org_created_idx that returns nothing.
 *
 * The key is the description, which the requester and the organization's
 * managers can edit. Nothing server-written marks a request an escalation
 * saved (the escalation calls the request form's own create()), and adding a
 * mark is a migration for a rare operations report. The description is
 * enough because the alert exists only so that someone tells the requester
 * the request exists: whoever can edit the reference out already knows it
 * exists, and doing so hides only that organization's own request from this
 * report, which gains nobody anything and cannot reach another organization,
 * whose requests are read separately.
 *
 * Resolved requests are left out (the runbook query kept them): the work is
 * done and a resolved request cannot be cancelled, so there is nothing to do.
 */
export const ORPHAN_SWEEP = {
  /** Daily (vercel.json, pinned by the route test). */
  schedule: '20 15 * * *',
  /** A request younger than this may still be linking: the finish is sent up
   *  to three times within a second or two of the insert, and a claim lives
   *  2 minutes. */
  graceMs: 10 * 60_000,
  /** How far back a run looks. Three days with a daily run: a request is
   *  reported on up to three runs (a reminder, not a flood), and one or two
   *  missed runs still find it. */
  lookbackMs: 72 * 60 * 60_000,
  /** The most requests one organization's read checks, oldest first.
   *  Escalations are a few a day, so reaching it means requests typed with
   *  "Ref EX-", not real volume. The read asks for one more, so an
   *  organization with exactly this many is not reported as capped. */
  maxCandidatesPerOrg: 500,
  /** Organizations read at the same time. */
  orgConcurrency: 4,
  /** No organization's read starts after this long into the run; those left
   *  are named. The route's maxDuration gives the reads in flight minutes to
   *  finish, since Vercel-to-Supabase calls can stall for seconds. */
  deadlineMs: 45_000,
  /** Unlinked requests the run's one alert lists, taken from each
   *  organization in turn; the rest are counted. */
  maxReports: 25,
  /** Organization ids one list in an alert names; the rest are counted. */
  maxNamedOrgs: 25,
} as const;

const DAY_MS = 24 * 60 * 60_000;

/** The prefill's reference to its exception (core escalationPrefill). */
const EXCEPTION_REFERENCE = /Ref (EX-[0-9]+)/;

type AdminClient = ReturnType<typeof createAdminClient>;

interface CandidateRow {
  id: string;
  organization_id: string;
  request_number: number | null;
  created_at: string;
  description: string | null;
}

/** One unlinked request, as an alert may name it: ids and system handles,
 *  never what a person typed (subject, description) or who they are. */
export interface UnlinkedEscalationRequest {
  id: string;
  organizationId: string;
  /** MR-YYYY-NNNNNN, or null when the row has no number. */
  reference: string | null;
  /** The EX-NNNNNN reference the description carries. */
  exceptionReference: string;
  createdAt: string;
}

/** An organization whose read reached ORPHAN_SWEEP.maxCandidatesPerOrg. */
export interface CappedOrganization {
  organizationId: string;
  /** Requests read and checked (the cap). */
  candidates: number;
  /** created_at of the last request checked: requests created after it in
   *  the window were not checked. */
  stoppedAt: string;
}

export interface UnlinkedEscalationScan {
  /** Organizations on the platform. */
  organizations: number;
  /** Organizations read. */
  read: number;
  /** Organizations not started before the run's deadline. */
  notRead: string[];
  /** Live requests in the window, in the organizations read, whose
   *  description mentions "Ref EX-". */
  candidates: number;
  capped: CappedOrganization[];
  /** By organization in the order read, oldest first within each. */
  orphans: UnlinkedEscalationRequest[];
}

interface OrganizationScan {
  candidates: number;
  capped: CappedOrganization | null;
  orphans: UnlinkedEscalationRequest[];
}

/**
 * Reads every organization, each on its own, with the service role. THROWS
 * when any read fails (the organization list, or one organization's requests
 * or links), and when the organization list is empty: a failed link read
 * would otherwise make every candidate look unlinked, and a skipped
 * organization would look like one with nothing to report, so the caller
 * must never take a failure for "none found".
 */
export async function findUnlinkedEscalationRequests(
  admin: AdminClient,
  now: number,
): Promise<UnlinkedEscalationScan> {
  const newest = new Date(now - ORPHAN_SWEEP.graceMs).toISOString();
  const oldest = new Date(now - ORPHAN_SWEEP.lookbackMs).toISOString();
  const deadline = now + ORPHAN_SWEEP.deadlineMs;

  const orgRows = await fetchAllRows<{ id: string }>((from, to) =>
    admin.from('organizations').select('id').order('id', { ascending: true }).range(from, to),
  );
  // The platform always has an organization; none means the read could not
  // see them (a client without the service role reads none, with no error).
  if (orgRows.length === 0) {
    throw new Error('Unlinked escalation check: the organizations read returned none');
  }
  const orgIds = sweepOrder(
    orgRows.map((o) => o.id),
    now,
  );

  // A failure stops new organizations from starting and is thrown once the
  // reads in flight settle (mapWithConcurrency).
  const scans = await mapWithConcurrency(orgIds, ORPHAN_SWEEP.orgConcurrency, async (orgId) => {
    if (Date.now() >= deadline) return null;
    try {
      return await scanOrganization(admin, orgId, oldest, newest);
    } catch (err) {
      // The database's words, which fetchAllRows keeps in internalDetail
      // behind a generic message, and the organization, so the run's report
      // says where to look.
      throw new Error(
        `Unlinked escalation check: the read for organization ${orgId} failed: ${rawErrorText(err)}`,
        { cause: err },
      );
    }
  });

  const result: UnlinkedEscalationScan = {
    organizations: orgIds.length,
    read: 0,
    notRead: [],
    candidates: 0,
    capped: [],
    orphans: [],
  };
  scans.forEach((scan, i) => {
    if (!scan) {
      result.notRead.push(orgIds[i]!);
      return;
    }
    result.read += 1;
    result.candidates += scan.candidates;
    if (scan.capped) result.capped.push(scan.capped);
    for (const orphan of scan.orphans) result.orphans.push(orphan);
  });
  return result;
}

/** Organization ids in id order, starting one organization later each day
 *  (the UTC day's number since 1970, modulo how many there are). A run cut
 *  short by its deadline reads the start of its order, and while there are
 *  N organizations each one starts the order on one of any N consecutive
 *  days, so each is read at least once in N days however few a run reads,
 *  with nothing stored between runs. N days can be longer than the
 *  three-day window, which is why each run's error alert names the
 *  organizations it did not read; only a stored per-organization time of
 *  the last read would bound it. An order that only alternated between two
 *  directions never read the middle organizations while runs read fewer
 *  than half. */
function sweepOrder(ids: readonly string[], now: number): string[] {
  const start = Math.floor(now / DAY_MS) % ids.length;
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/** One organization's live "Ref EX-" requests in the window (at most the
 *  cap, oldest first) and which of them no exception links. Throws on a
 *  failed read. */
async function scanOrganization(
  admin: AdminClient,
  orgId: string,
  oldest: string,
  newest: string,
): Promise<OrganizationScan> {
  const rows = await fetchAllRows<CandidateRow>(
    (from, to) =>
      admin
        .from('maintenance_requests')
        .select('id, organization_id, request_number, created_at, description')
        .eq('organization_id', orgId)
        .is('cancelled_at', null)
        .is('archived_at', null)
        .is('resolved_at', null)
        .like('description', '%Ref EX-%')
        .gte('created_at', oldest)
        .lt('created_at', newest)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { cap: ORPHAN_SWEEP.maxCandidatesPerOrg + 1 },
  );
  const checked = rows.slice(0, ORPHAN_SWEEP.maxCandidatesPerOrg);
  const last = checked[checked.length - 1];
  const capped =
    rows.length > checked.length && last
      ? { organizationId: orgId, candidates: checked.length, stoppedAt: last.created_at }
      : null;

  // The LIKE above is the coarse cut; the reference must carry a number, as
  // the runbook's `~ 'Ref EX-[0-9]+'` required.
  const withReference = checked.flatMap((r) => {
    const exceptionReference = EXCEPTION_REFERENCE.exec(r.description ?? '')?.[1];
    return exceptionReference ? [{ row: r, exceptionReference }] : [];
  });

  const linkedPages = await mapIdBatches(
    withReference.map((c) => c.row.id),
    async (batch) => {
      const { data, error } = await admin
        .from('exception_occurrences')
        .select('maintenance_request_id')
        .in('maintenance_request_id', batch);
      if (error) throw new Error(`exception_occurrences link read: ${error.message}`);
      return (data ?? []) as Array<{ maintenance_request_id: string | null }>;
    },
    { concurrency: 2 },
  );
  const linked = new Set(linkedPages.flat().map((l) => l.maintenance_request_id));

  return {
    candidates: checked.length,
    capped,
    orphans: withReference
      .filter((c) => !linked.has(c.row.id))
      .map(({ row, exceptionReference }) => ({
        id: row.id,
        organizationId: row.organization_id,
        reference: formatMaintenanceRequestNumber(row.request_number, row.created_at),
        exceptionReference,
        createdAt: row.created_at,
      })),
  };
}

/**
 * The text of the run's one alert about unlinked requests, or null when there
 * are none. Everything a person needs is in the text, because a Slack
 * incoming webhook receives the text alone (reportError drops `extra`): each
 * request by handle, EX reference and id, under its organization's id, and
 * never its subject, description or requester.
 *
 * At most ORPHAN_SWEEP.maxReports requests are listed, taken from each
 * organization in turn (oldest first within each), so one organization's
 * requests cannot crowd another's out of the list; the rest are counted, and
 * an organization with none listed is still named.
 */
export function unlinkedRequestsAlert(
  orphans: readonly UnlinkedEscalationRequest[],
): { message: string; listed: number } | null {
  if (orphans.length === 0) return null;
  const byOrg = new Map<string, UnlinkedEscalationRequest[]>();
  for (const o of orphans) {
    const list = byOrg.get(o.organizationId);
    if (list) list.push(o);
    else byOrg.set(o.organizationId, [o]);
  }

  const take = new Map<string, number>();
  let listed = 0;
  for (let round = 0; listed < ORPHAN_SWEEP.maxReports; round += 1) {
    let took = false;
    for (const [orgId, list] of byOrg) {
      if (listed >= ORPHAN_SWEEP.maxReports) break;
      if (round >= list.length) continue;
      take.set(orgId, round + 1);
      listed += 1;
      took = true;
    }
    if (!took) break;
  }

  const lines = [
    orphans.length === 1
      ? '1 maintenance request saved by an exception escalation is linked to no exception. Tell its requester, who can cancel it.'
      : `${orphans.length} maintenance requests saved by an exception escalation are linked to no exception. Tell each requester, who can cancel it.`,
  ];
  const unlistedOrgs: string[] = [];
  let unlistedRequests = 0;
  for (const [orgId, list] of byOrg) {
    const k = take.get(orgId) ?? 0;
    if (k === 0) {
      unlistedOrgs.push(orgId);
      unlistedRequests += list.length;
      continue;
    }
    lines.push(
      `Organization ${orgId}: ${list.length} unlinked${k < list.length ? `, the oldest ${k} listed` : ''}`,
    );
    for (const o of list.slice(0, k)) {
      lines.push(
        `  ${o.reference ?? 'MR (no number)'} for ${o.exceptionReference}: request ${o.id}, created ${o.createdAt}`,
      );
    }
  }
  if (unlistedOrgs.length > 0) {
    lines.push(
      `${unlistedOrgs.length} more ${unlistedOrgs.length === 1 ? 'organization has' : 'organizations have'} ${unlistedRequests} unlinked, not listed: ${namedList(unlistedOrgs)}`,
    );
  }
  return { message: lines.join('\n'), listed };
}

/**
 * The text of the run's error alert when it did not read everything in its
 * window, or null when it did: each organization that reached its cap, with
 * how many it read and the created_at its read stopped at, and the
 * organizations not read before the deadline. Ids only.
 */
export function incompleteRunAlert(
  scan: Pick<UnlinkedEscalationScan, 'capped' | 'notRead'>,
): string | null {
  const { capped, notRead } = scan;
  if (capped.length === 0 && notRead.length === 0) return null;
  const lines = [
    `The unlinked escalation check did not read every request in its ${ORPHAN_SWEEP.lookbackMs / DAY_MS}-day window, so this run may have missed unlinked ones.`,
  ];
  if (capped.length > 0) {
    lines.push(
      `Reached the cap of ${ORPHAN_SWEEP.maxCandidatesPerOrg} requests mentioning "Ref EX-" (each organization is read on its own, oldest first; later requests were not checked):`,
    );
    for (const c of capped.slice(0, ORPHAN_SWEEP.maxNamedOrgs)) {
      lines.push(
        `  Organization ${c.organizationId}: ${c.candidates} read, the last created ${c.stoppedAt}`,
      );
    }
    if (capped.length > ORPHAN_SWEEP.maxNamedOrgs) {
      lines.push(`  and ${capped.length - ORPHAN_SWEEP.maxNamedOrgs} more organizations`);
    }
  }
  if (notRead.length > 0) {
    lines.push(
      `Not read before the run's ${ORPHAN_SWEEP.deadlineMs / 1000}-second limit, ${notRead.length} ${notRead.length === 1 ? 'organization' : 'organizations'}: ${namedList(notRead)}`,
    );
  }
  return lines.join('\n');
}

/** Up to ORPHAN_SWEEP.maxNamedOrgs ids, then how many more. */
function namedList(ids: readonly string[]): string {
  const named = ids.slice(0, ORPHAN_SWEEP.maxNamedOrgs).join(', ');
  const more = ids.length - ORPHAN_SWEEP.maxNamedOrgs;
  return more > 0 ? `${named}, and ${more} more` : named;
}

/**
 * An Error for a run report: `message` and no stack. reportError appends the
 * stack to the text the alerts channel receives, and a report's stack is
 * only this cron's own frames repeating the message.
 */
export function runReport(message: string): Error {
  const report = new Error(message);
  report.stack = '';
  return report;
}
