import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import {
  DIGEST_FROM,
  renderWeeklyDigestHtml,
  weeklyDigestSubject,
  weeklyDigestText,
} from '@/lib/email/es/families/digest';
import { memberUnsubscribeDelivery } from '@/lib/email/member-unsubscribe';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  applySectionOptIns,
  buildDigestPayload,
  digestReaderFor,
  getDigestSource,
  isDigestEmpty,
  loadDigestReaderData,
} from '@/server/services/digest';
import { rawErrorText } from '@/server/services/lib/fetch-by-ids';
import { claimRetries, sweepOrganizations } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Constant-time string compare. A naive `a !== b` short-circuits at the
 * first differing byte and leaks the length of the matching prefix
 * through timing. timingSafeEqual compares every byte regardless of
 * mismatch position. See cron/purge-ai-chat-history for the same guard.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
/**
 * The Monday (UTC) that starts the run's week, as `YYYY-MM-DD`. This is the
 * week bucket of the at-most-once send key: every invocation inside one
 * cron week — the scheduled 14:00 UTC Monday run, a manual re-run on the
 * Wednesday — derives the SAME bucket, so only the first one sends. The
 * next scheduled run is always >= 7 days later, so it lands in a new bucket
 * and sends normally. Date.UTC normalizes a negative day-of-month (Monday
 * of a week that started in the previous month), so no manual rollover.
 */
// (module-private: a route file may only export the handler + route config)
function digestWeekKey(d: Date): string {
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // getUTCDay: 0 = Sunday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday),
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * The claim's request_hash when the run can sign: an HMAC over (organization,
 * key) under the run's claim key (digestClaimKeyMaterial). A row under the key
 * counts as "sent" only when it carries this value, which is bound to this
 * organization, member and week.
 */
function digestClaimSignature(keyMaterial: Buffer, orgId: string, claimKey: string): string {
  return createHmac('sha256', keyMaterial)
    .update(`weekly_digest_claim:v1|${orgId}|${claimKey}`)
    .digest('hex');
}

/** The shortest UNSUBSCRIBE_SECRET the claim key is derived from. */
const MIN_CLAIM_SIGNING_LENGTH = 32;

/**
 * The run's claim key: HMAC-SHA256 of a fixed label under UNSUBSCRIBE_SECRET
 * (a signing-only value; the label keeps the claim apart from the unsubscribe
 * links signed with the same value), or null when that value is unset or
 * shorter than MIN_CLAIM_SIGNING_LENGTH. The run then claims unsigned.
 */
function digestClaimKeyMaterial(signingValue: string | undefined): Buffer | null {
  if (!signingValue || signingValue.length < MIN_CLAIM_SIGNING_LENGTH) return null;
  return createHmac('sha256', signingValue).update('weekly_digest_claim_key:v1').digest();
}

/** The unsigned form of a claim: what a run that cannot sign stores, and what
 *  every claim stored before claims were signed carries. */
function unsignedClaimHash(orgId: string, claimKey: string): string {
  return createHash('sha256').update(`${orgId}:${claimKey}`).digest('hex');
}

/**
 * The last claim week whose unsigned form still marks the week sent when the
 * run can sign (the weeks claimed before claims were signed). Any later week
 * needs the signature.
 */
const LAST_UNSIGNED_CLAIM_WEEK = '2026-11-09'; // the release owner raises this to the next Monday if the change goes live after that Monday's run

/** How many times a run tries to hold the week's claim before it sends unclaimed. */
const MAX_CLAIM_TRIES = 3;

/** The steps of a member's week claim that can go wrong (claimReporter). */
type DigestClaimStep = 'claim' | 'read' | 'take_over';

/** What each claim step's report says. No id, no address, no database text. */
const CLAIM_STEP_MESSAGE: Record<DigestClaimStep, string> = {
  claim: 'Weekly digest skipped members whose week claim could not be recorded',
  read: 'Weekly digest could not read a week claim and left the week marked sent',
  take_over: 'Weekly digest claim under the key is not signed and could not be taken over',
};

type ClaimReport = (step: DigestClaimStep, error?: { code?: string } | null) => void;

/**
 * The run's claim reports: each step reported at most once per run, under
 * cron.weekly-digest.claim, with the step, the job and the error's code only
 * (`lastClaimCode`: the last code of a claim that could not be recorded).
 * The counts are in the run's log line.
 */
function claimReporter(): ClaimReport & { lastClaimCode(): string } {
  const done = new Set<DigestClaimStep>();
  let lastClaimCode = 'none';
  const report: ClaimReport = (step, error) => {
    // `||`: a fetch-level failure can carry an empty code. The code is in
    // the message too: a chat webhook shows only the message.
    const code = error?.code || 'none';
    if (step === 'claim') lastClaimCode = code;
    if (done.has(step)) return;
    done.add(step);
    void reportError(new Error(`${CLAIM_STEP_MESSAGE[step]} (code ${code})`), {
      tag: 'cron.weekly-digest.claim',
      level: 'warning',
      extra: { step, job: 'weekly_digest', code },
    });
  };
  return Object.assign(report, { lastClaimCode: () => lastClaimCode });
}

interface DigestClaimRow {
  organization_id: string;
  scope: 'weekly_digest';
  key: string;
  request_hash: string;
  status: 'completed';
}

function isDuplicateClaim(err: { code?: string; message?: string }): boolean {
  return err.code === '23505' || (err.message ?? '').includes('duplicate key value');
}

type DigestClaimRead =
  | { kind: 'ours' }
  | { kind: 'other'; id: string; hash: string }
  | { kind: 'none' }
  | { kind: 'unreadable' };

/** The row under (org, weekly_digest, key), judged against the signature. A
 *  failed read is reported here (once per run). */
async function readDigestClaim(
  admin: ReturnType<typeof createAdminClient>,
  claim: DigestClaimRow,
  report: ClaimReport,
): Promise<DigestClaimRead> {
  const orgId = claim.organization_id;
  const { data, error } = await admin
    .from('idempotency_keys')
    .select('id, request_hash')
    .eq('organization_id', orgId)
    .eq('scope', 'weekly_digest')
    .eq('key', claim.key)
    .maybeSingle();
  if (error) {
    report('read', error);
    return { kind: 'unreadable' };
  }
  const row = data as { id: string; request_hash: string | null } | null;
  if (!row) return { kind: 'none' };
  if (row.request_hash === claim.request_hash) return { kind: 'ours' };
  const week = claim.key.slice(claim.key.lastIndexOf(':') + 1);
  if (week <= LAST_UNSIGNED_CLAIM_WEEK && row.request_hash === unsignedClaimHash(orgId, claim.key)) {
    return { kind: 'ours' };
  }
  return { kind: 'other', id: row.id, hash: row.request_hash ?? '' };
}

/**
 * After the signed insert met an existing row: 'send' when this run may send,
 * 'sent' when the week is already marked sent, 'unavailable' when the claim
 * cannot be recorded. Up to MAX_CLAIM_TRIES times, the row is read and:
 *   * a signed claim (or an unsigned one of a week up to
 *     LAST_UNSIGNED_CLAIM_WEEK): already sent, 'sent';
 *   * the row cannot be read: reported, 'sent' (a row is there; at most once
 *     wins without proof it is not signed);
 *   * a row without the cron's signature: taken over by a compare-and-set on
 *     the hash it was read with; 'send' when it holds, 'unavailable'
 *     (reported) when the write errors;
 *   * no row any more: claimed again; 'send' when the insert holds,
 *     'unavailable' (reported) when it fails with an error other than the key.
 * A try that misses (the row changed first, no error) reads again. After the
 * last miss the run reports and sends without holding the claim.
 */
async function mayClaimTakenWeek(
  admin: ReturnType<typeof createAdminClient>,
  claim: DigestClaimRow,
  report: ClaimReport,
): Promise<'send' | 'sent' | 'unavailable'> {
  const orgId = claim.organization_id;
  for (let attempt = 0; attempt < MAX_CLAIM_TRIES; attempt += 1) {
    const held = await readDigestClaim(admin, claim, report);
    if (held.kind === 'ours' || held.kind === 'unreadable') return 'sent';
    if (held.kind === 'none') {
      const { error: insertErr } = await admin.from('idempotency_keys').insert(claim);
      if (!insertErr) return 'send';
      // Fails closed, as the first claim does: the member is skipped.
      if (!isDuplicateClaim(insertErr)) {
        report('claim', insertErr);
        return 'unavailable';
      }
      continue;
    }
    const { data, error } = await admin
      .from('idempotency_keys')
      .update({ request_hash: claim.request_hash, status: 'completed' })
      .eq('organization_id', orgId)
      .eq('id', held.id)
      .eq('request_hash', held.hash)
      .select('id');
    if (error) {
      report('claim', error);
      return 'unavailable';
    }
    if (Array.isArray(data) && data.length > 0) return 'send';
  }
  report('take_over');
  return 'send';
}

// The cron iterates orgs + sends emails sequentially (each Resend send is a
// network round trip). 300, up from 60: the job runs once a WEEK, so an
// organization a run does not reach waits a whole week for its digest. 300 is
// what the daily per-organization jobs use, and the soft deadline below
// leaves the organization in flight a minute to finish its sends.
export const maxDuration = 300;

/** Stop STARTING organizations after this long (see maxDuration). */
const RUN_DEADLINE_MS = 240_000;
/** The job's cadence: the slot of the fallback order (rotateByClock). */
const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * Weekly inventory digest. Wired to Vercel Cron via vercel.json
 * (0 14 * * 1: 14:00 UTC Mondays, 7 AM Pacific in summer and 6 AM in
 * winter; the email's footer states it in the org's zone). Uses the service-role
 * client to span all orgs, so it reads each org once and then cuts what
 * each recipient is sent to what that recipient may read
 * (buildDigestPayload with their reader; see services/digest.ts).
 *
 * Auth: same Bearer ${CRON_SECRET} pattern as purge-ai-chat-history.
 *
 * Order: the organizations this job reached longest ago first
 * (cron_sweep_attempts, job 'weekly_digest', recorded as each starts), so a
 * run cut by its deadline leaves different organizations each week, and
 * those go first the next week. One log line per run says how many it left.
 * Nothing is claimed per organization: the week's claim per (organization,
 * member) below keeps every member at one digest a week, and lets a run
 * started again the same week finish an organization another run left half
 * way. A member whose claim cannot be recorded is skipped for the run, never
 * sent unclaimed (counted in the log line as claimUnavailable).
 *
 * Spec: docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md
 */
export async function GET(req: Request) {
  // Fail-closed when CRON_SECRET is unset/empty. Without this guard,
  // an unauthenticated GET could trigger an org-wide email blast via
  // Resend on the org's account. See cron/purge-ai-chat-history for
  // the matching pattern.
  if (!env.CRON_SECRET) {
    // Match cron/purge-ai-chat-history: fail-closed with 401 so the
    // endpoint's existence isn't differentiable from "wrong secret".
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // The run's deadline counts from here, before the recipient pull: the time
  // that pull takes is spent from the same maxDuration.
  const requestStartedAt = Date.now();
  // The claim's signing key for this run (digestClaimKeyMaterial), computed
  // once; null claims unsigned, reported once per run.
  const claimKeyMaterial = digestClaimKeyMaterial(env.UNSUBSCRIBE_SECRET);
  let unsignedReported = false;
  const reportClaim = claimReporter();
  // A member claim that errors is tried once more (claimRetries), so one
  // passing error does not cost the member their week.
  const retries = claimRetries();
  /** Members whose claim insert was tried (for the all-skipped report). */
  let claimsTried = 0;
  let sendReported = false;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  /** Members skipped because their week claim could not be recorded. */
  let claimUnavailable = 0;

  try {
    const admin = createAdminClient();

    // Pull every opted-in user along with their org membership + per-
    // section flags. One query — joins user_profiles → organization_members
    // → organizations. Per-section flags are filtered AT RENDER TIME so
    // each user's digest reflects only the sections they're subscribed to.
    // Paginated via fetchAllRows to avoid the silent 1000-row PostgREST cap.
    //
    // The embed NAMES its foreign key: organization_members has two to
    // user_profiles (user_id, and invited_by), and PostgREST refuses an embed
    // that names neither with HTTP 300 PGRST201. Without the hint this pull
    // failed every Monday and no digest was ever sent. A recipient's
    // memberships are the rows whose user_id is the recipient. The hint does
    // not rename the embed, so the accepted_at filter below still says
    // `organization_members`.
    type RecipientRow = {
      id: string;
      email: string;
      full_name: string | null;
      digest_section_low_stock: boolean | null;
      digest_section_open_pos: boolean | null;
      digest_section_cycle_counts: boolean | null;
      organization_members: Array<{
        organization_id: string;
        accepted_at: string | null;
        organizations:
          | { id: string; name: string; timezone: string | null }
          | { id: string; name: string; timezone: string | null }[]
          | null;
      }>;
    };

    const recipients = await fetchAllRows<RecipientRow>((from, to) =>
      admin
        .from('user_profiles')
        .select(
          `
        id, email, full_name,
        digest_section_low_stock,
        digest_section_open_pos,
        digest_section_cycle_counts,
        organization_members!organization_members_user_id_fkey!inner (
          organization_id,
          accepted_at,
          organizations:organization_id (id, name, timezone)
        )
      `,
        )
        .eq('email_digest_optin', true)
        // A disabled account must not receive the digest — RLS blocks its
        // reads, but this cron runs as service-role and would otherwise
        // build the recipient set with no regard for the disable program
        // (migs 0308-0311). One predicate on the base table, no extra
        // round trip. (Re-checked per-recipient below too, immediately
        // before send — see that comment for why.)
        .is('disabled_at', null)
        .not('organization_members.accepted_at', 'is', null)
        // A platform admin's "act as" grant (services/platform/impersonation.ts)
        // is an accepted 'owner' row with a 45-minute expiry, not a
        // membership: every other cron leaves it out, and so does the digest.
        // Without this an opted-in platform admin acting as a customer at
        // send time got that customer's digest, and the claim below landed
        // in the customer's idempotency_keys.
        .is('organization_members.impersonation_expires_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );

    interface RecipientLite {
      userId: string;
      email: string;
      name: string | null;
      sections: { lowStock: boolean; openPos: boolean; cycleCounts: boolean };
    }

    // Fan recipients out by org so each org is read once even if multiple
    // users in the same org are opted in.
    const byOrg = new Map<
      string,
      { orgName: string; timeZone: string | null; recipients: RecipientLite[] }
    >();
    for (const row of recipients) {
      const sections = {
        lowStock: row.digest_section_low_stock ?? true,
        openPos: row.digest_section_open_pos ?? true,
        cycleCounts: row.digest_section_cycle_counts ?? true,
      };
      // If every section is opted out, skip this user — they'd receive nothing.
      if (!sections.lowStock && !sections.openPos && !sections.cycleCounts) {
        skipped += 1;
        continue;
      }
      for (const m of row.organization_members ?? []) {
        if (!m.accepted_at) continue;
        const orgRow = Array.isArray(m.organizations)
          ? m.organizations[0]
          : m.organizations;
        if (!orgRow) continue;
        const existing = byOrg.get(orgRow.id) ?? {
          orgName: orgRow.name,
          // For the send time the footer states, and the day that decides
          // OVERDUE, in the org's zone.
          timeZone: orgRow.timezone ?? null,
          recipients: [],
        };
        if (!existing.recipients.some((r) => r.userId === row.id)) {
          existing.recipients.push({
            userId: row.id,
            email: row.email,
            name: row.full_name,
            sections,
          });
        }
        byOrg.set(orgRow.id, existing);
      }
    }

    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    const settingsUrl = `${appUrl}/dashboard/settings/notifications`;
    // Lock the subject's date label to the cron-start time so every
    // recipient in an organization gets the same dateline, even if the loop
    // spans midnight.
    const runStartedAt = new Date();

    const sweep = await sweepOrganizations(
      admin,
      {
        job: 'weekly_digest',
        tag: 'cron.weekly-digest',
        orgIds: [...byOrg.keys()],
        deadlineAt: requestStartedAt + RUN_DEADLINE_MS,
        slotMs: WEEK_MS,
      },
      async (orgId): Promise<{ result: 'success' | 'failure'; value: null }> => {
        const group = byOrg.get(orgId)!;
        try {
          // The organization's date, not the server's (small fixes slice 8):
          // this run (Mondays 14:00 UTC) is already Tuesday from UTC+10 east.
          const subject = weeklyDigestSubject(runStartedAt, group.timeZone);
          // One org-wide read (the service role sees every row), plus what
          // decides each recipient's view: their warehouse and category
          // assignments and the purchase_orders:read permission. A failed read
          // throws to the per-org catch below, so nobody in the org is sent a
          // wider view than theirs.
          //
          // OVERDUE is decided in the org's own zone as of the run's start: a
          // purchase order is overdue once the org's date is after its expected
          // day (core isPastExpectedDay). Before, the Monday run (7 AM in Los
          // Angeles) flagged every purchase order expected that Monday.
          const [source, readerData] = await Promise.all([
            getDigestSource(admin, orgId, { timeZone: group.timeZone, now: runStartedAt }),
            loadDigestReaderData(
              admin,
              orgId,
              group.recipients.map((r) => r.userId),
            ),
          ]);
          // The plain text's dateline and days, at the run's start, in the
          // organization's zone like the HTML.
          const opts = {
            orgName: group.orgName,
            appUrl,
            settingsUrl,
            now: runStartedAt,
            timeZone: group.timeZone,
          };
          for (const { userId, email: to, name, sections } of group.recipients) {
            // Re-check membership + opt-in + disabled-status IMMEDIATELY
            // before sending. The recipient set was assembled at the top of
            // this run — for a large fleet that gap can be tens of seconds.
            // If the user toggled the digest off, was removed from the org,
            // or was disabled, we must not deliver. Two cheap point reads
            // guard all three axes:
            //   1) organization_members still active for (org, user)
            //   2) user_profiles.email_digest_optin still true, and
            //      user_profiles.disabled_at still null — the SAME row the
            //      initial pull already filtered on, re-read here to close
            //      the gap rather than as a new round trip.
            const [membershipRes, profileRes] = await Promise.all([
              admin
                .from('organization_members')
                .select('user_id, accepted_at, role')
                .eq('organization_id', orgId)
                .eq('user_id', userId)
                // An "act as" grant is not a membership (see the pull above).
                .is('impersonation_expires_at', null)
                .maybeSingle(),
              admin
                .from('user_profiles')
                .select('email_digest_optin, disabled_at')
                .eq('id', userId)
                .maybeSingle(),
            ]);
            const membership = membershipRes.data as
              | { user_id: string; accepted_at: string | null; role: string }
              | null;
            const profile = profileRes.data as
              | { email_digest_optin: boolean | null; disabled_at: string | null }
              | null;
            if (!membership || !membership.accepted_at) {
              skipped += 1;
              continue;
            }
            if (!profile || profile.email_digest_optin === false) {
              skipped += 1;
              continue;
            }
            if (profile.disabled_at) {
              skipped += 1;
              continue;
            }

            // Each recipient is sent what they may read in StockPilot, which
            // is also what their "Send preview now" shows: the role read just
            // now, with their assignments and permission (services/digest.ts
            // restates the SELECT policies). Then only their opted-in
            // sections; one or two could be all-empty even when the org's
            // source isn't.
            const reader = digestReaderFor(readerData, userId, membership.role);
            const payload = applySectionOptIns(buildDigestPayload(source, reader), sections);
            if (isDigestEmpty(payload)) {
              skipped += 1;
              continue;
            }
            // ═══ AT-MOST-ONCE PER (org, user, week) ═══
            //
            // This cron had no send marker of ANY kind, so a second
            // invocation inside the same week re-sent the identical digest
            // (same subject dateline) to every opted-in user. Two reachable
            // paths: a manual `curl -H "Authorization: Bearer $CRON_SECRET"`
            // / the Vercel dashboard "Run" button after a deploy, and the
            // honest operational case — a fleet large enough to blow
            // maxDuration=60 gets cut off mid-loop with no resume point, so
            // the natural operator response (re-run to finish the list)
            // re-mails everyone already served.
            //
            // The claim rides the generic idempotency_keys table (mig 0013).
            // Its UNIQUE (organization_id, scope, key) makes claiming ATOMIC
            // — a read-then-write marker would still double-send under two
            // overlapping runs — and needs no new column.
            //
            // The key is per (org, user, week), NOT per user: a user who
            // belongs to two orgs legitimately receives two digests every
            // Monday (this loop fans out per membership), so a per-user key
            // would silently suppress the second org's digest.
            //
            // Claimed BEFORE the send, like schedule-reminders' stamp-first
            // write: losing one digest to a crash between claim and send
            // beats re-spamming the fleet.
            //
            // The row's request_hash is the run's signature over (org, key)
            // (digestClaimSignature) when the run can sign: a row under the key
            // marks the week sent only when it carries it (mayClaimTakenWeek).
            const claimKey = `${userId}:${digestWeekKey(runStartedAt)}`;
            const signature = claimKeyMaterial
              ? digestClaimSignature(claimKeyMaterial, orgId, claimKey)
              : null;
            if (!signature && !unsignedReported) {
              unsignedReported = true;
              // The condition only: no secret material, no length.
              void reportError(
                new Error(
                  'weekly digest claims are unsigned this run: UNSUBSCRIBE_SECRET is unset or shorter than 32 characters',
                ),
                { tag: 'cron.weekly-digest.claim_unsigned' },
              );
            }
            const claim: DigestClaimRow = {
              organization_id: orgId,
              scope: 'weekly_digest',
              key: claimKey,
              request_hash: signature ?? unsignedClaimHash(orgId, claimKey),
              status: 'completed',
            };
            claimsTried += 1;
            let { error: claimErr } = await admin.from('idempotency_keys').insert(claim);
            if (claimErr && !isDuplicateClaim(claimErr) && (await retries.wait())) {
              // A retry that meets the key finds a claim already there (this
              // run's own first insert, if it committed and only its reply was
              // lost): handled as any duplicate below.
              ({ error: claimErr } = await admin.from('idempotency_keys').insert(claim));
              if (claimErr && !isDuplicateClaim(claimErr)) retries.retryFailed();
            }
            if (claimErr) {
              // Already sent this week (the whole point). A signed run sends
              // anyway when the row does not carry its signature
              // (mayClaimTakenWeek); an unsigned run takes any row as sent.
              const taken = isDuplicateClaim(claimErr)
                ? signature
                  ? await mayClaimTakenWeek(admin, claim, reportClaim)
                  : 'sent'
                : 'unavailable';
              if (taken === 'sent') {
                skipped += 1;
                continue;
              }
              if (taken === 'unavailable') {
                // Any OTHER claim failure (the table missing, a refused
                // write), on the retry too, FAILS CLOSED: without the claim
                // nothing stops a second run in the same week from sending
                // this member the same digest, so the member is skipped for
                // this run, counted (claimUnavailable) and reported once per
                // run, codes only. Usually nothing was written, so a run
                // started again the same week sends it once the claim can be
                // recorded. (An insert that committed but whose reply was lost
                // did write the claim: that run then takes the week as sent.)
                // The only scheduled run is Monday's (vercel.json,
                // 0 14 * * 1) and next Monday's run is a new week, so without
                // such a run the member gets no digest for this week.
                claimUnavailable += 1;
                // (mayClaimTakenWeek reports its own.)
                if (!isDuplicateClaim(claimErr)) reportClaim('claim', claimErr);
                continue;
              }
            }

            // The recipient's own signed one-click link for this org's digest
            // (lib/email/member-unsubscribe.ts): List-Unsubscribe and
            // List-Unsubscribe-Post, and the footer's and the text part's
            // Unsubscribe. /unsubscribe honours it signed out and on a mail
            // provider's RFC 8058 POST by turning off this member's
            // email_digest_optin, the settings page's own switch. Without a
            // signing value it is the settings page, with no -Post header.
            // Dated with the run's UTC day: the link works for 90 days.
            const unsubscribe = memberUnsubscribeDelivery({
              appUrl,
              settingsUrl,
              claim: { userId, organizationId: orgId, kind: 'weekly_digest' },
              issuedAt: runStartedAt,
            });
            const html = renderWeeklyDigestHtml(payload, {
              ...opts,
              unsubscribeUrl: unsubscribe.url,
              recipientName: name,
              now: runStartedAt,
              timeZone: group.timeZone,
            });
            const text = weeklyDigestText(payload, { ...opts, unsubscribeUrl: unsubscribe.url });
            const res = await sendEmail({
              to,
              subject,
              html,
              text,
              from: DIGEST_FROM,
              headers: unsubscribe.headers,
            });
            if (res.ok) sent += 1;
            else {
              failed += 1;
              // Once per run, no address and no id: the count is in the log
              // line, and sendEmail logs the provider's own answer.
              if (!sendReported) {
                sendReported = true;
                void reportError(new Error('Weekly digest emails could not be sent'), {
                  tag: 'cron.weekly-digest.send',
                });
              }
            }
          }
          return { result: 'success', value: null };
        } catch (orgErr) {
          // One bad org shouldn't kill the whole run.
          failed += group.recipients.length;
          // The read's own text (rawErrorText): the reporter logs and posts an
          // error's message only, and a ServiceError('internal_error') from a
          // failed or non-list read keeps its text in internalDetail behind the
          // generic sentence (docket S27).
          void reportError(new Error(rawErrorText(orgErr)), {
            tag: 'cron.weekly-digest.org',
            extra: { orgId },
          });
          return { result: 'failure', value: null };
        }
      },
    );

    if (claimUnavailable > 0 && claimUnavailable === claimsTried) {
      // Every member this run tried to claim was skipped: the claims are down
      // for everyone, not one passing error. An error, not a warning.
      void reportError(
        new Error(
          `Weekly digest skipped every member it tried: week claims could not be recorded (code ${reportClaim.lastClaimCode()})`,
        ),
        {
          tag: 'cron.weekly-digest.claims_down',
          level: 'error',
          extra: { job: 'weekly_digest', code: reportClaim.lastClaimCode(), skipped: claimUnavailable },
        },
      );
    }

    // One line per run, counts only (no org ids, no addresses).
    console.info(
      '[cron.weekly-digest]',
      JSON.stringify({
        organizations: byOrg.size,
        sent,
        skipped,
        failed,
        claimUnavailable,
        failingRepeatedly: sweep.failingRepeatedly,
        orderedBy: sweep.orderedBy,
        promoted: sweep.promoted,
        leftForNextRun: sweep.leftForNextRun,
        ms: Date.now() - requestStartedAt,
      }),
    );

    return NextResponse.json({ ok: true, sent, skipped, failed, leftForNextRun: sweep.leftForNextRun });
  } catch (err) {
    return internalErrorResponse(err, 'cron.weekly-digest', { body: { sent, skipped, failed } });
  }
}
