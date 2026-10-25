import 'server-only';

import { formatMaintenanceRequestNumber } from '@stockpilot/core';

import type { createAdminClient } from '@/lib/supabase/admin';

import { mapIdBatches } from './lib/fetch-by-ids';
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
  /** A bound on what one run reads (escalations are a few a day). A run that
   *  reaches it says so in its summary. */
  maxCandidates: 1000,
  /** Alerts one run sends, one per request; the rest are counted in one more
   *  alert, so a burst cannot flood the alerts channel. */
  maxReports: 25,
} as const;

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

export interface UnlinkedEscalationScan {
  /** Live requests in the window whose description carries "Ref EX-<n>". */
  candidates: number;
  /** True when the read stopped at ORPHAN_SWEEP.maxCandidates. */
  truncated: boolean;
  /** Oldest first. */
  orphans: UnlinkedEscalationRequest[];
}

/**
 * Reads, across every organization, with the service role. THROWS when
 * either read fails: a failed link read would otherwise make every candidate
 * look unlinked, so the caller must never take a failure for "none found".
 */
export async function findUnlinkedEscalationRequests(
  admin: AdminClient,
  now: number,
): Promise<UnlinkedEscalationScan> {
  const newest = new Date(now - ORPHAN_SWEEP.graceMs).toISOString();
  const oldest = new Date(now - ORPHAN_SWEEP.lookbackMs).toISOString();

  const rows = await fetchAllRows<CandidateRow>(
    (from, to) =>
      admin
        .from('maintenance_requests')
        .select('id, organization_id, request_number, created_at, description')
        .is('cancelled_at', null)
        .is('archived_at', null)
        .is('resolved_at', null)
        .like('description', '%Ref EX-%')
        .gte('created_at', oldest)
        .lt('created_at', newest)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { cap: ORPHAN_SWEEP.maxCandidates },
  );

  // The LIKE above is the coarse cut; the reference must carry a number, as
  // the runbook's `~ 'Ref EX-[0-9]+'` required.
  const candidates = rows.flatMap((r) => {
    const exceptionReference = EXCEPTION_REFERENCE.exec(r.description ?? '')?.[1];
    return exceptionReference ? [{ row: r, exceptionReference }] : [];
  });

  const linkedPages = await mapIdBatches(
    candidates.map((c) => c.row.id),
    async (batch) => {
      const { data, error } = await admin
        .from('exception_occurrences')
        .select('maintenance_request_id')
        .in('maintenance_request_id', batch);
      if (error) throw new Error(`exception_occurrences link read: ${error.message}`);
      return (data ?? []) as Array<{ maintenance_request_id: string | null }>;
    },
  );
  const linked = new Set(linkedPages.flat().map((l) => l.maintenance_request_id));

  return {
    candidates: candidates.length,
    truncated: rows.length >= ORPHAN_SWEEP.maxCandidates,
    orphans: candidates
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
