import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import {
  DIGEST_FROM,
  renderWeeklyDigestHtml,
  weeklyDigestSubject,
  weeklyDigestText,
} from '@/lib/email/es/families/digest';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  applySectionOptIns,
  buildDigestPayload,
  digestReaderFor,
  getDigestSource,
  isDigestEmpty,
  loadDigestReaderData,
} from '@/server/services/digest';
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

// Vercel default function timeout is 10s for Hobby. The cron iterates orgs
// + sends emails sequentially; bump generously since each Resend send is
// a network round trip.
export const maxDuration = 60;

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

  let sent = 0;
  let skipped = 0;
  let failed = 0;

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
    // recipient in this run gets the same dateline, even if the loop
    // spans midnight UTC.
    const runStartedAt = new Date();
    const subject = weeklyDigestSubject(runStartedAt);

    for (const [orgId, group] of byOrg) {
      try {
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
        const opts = { orgName: group.orgName, appUrl, settingsUrl };
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
          const claimKey = `${userId}:${digestWeekKey(runStartedAt)}`;
          const { error: claimErr } = await admin.from('idempotency_keys').insert({
            organization_id: orgId,
            scope: 'weekly_digest',
            key: claimKey,
            // request_hash is NOT NULL on the table; the "payload" of a
            // digest send is exactly its (org, user, week) identity.
            request_hash: createHash('sha256').update(`${orgId}:${claimKey}`).digest('hex'),
            status: 'completed',
          });
          if (claimErr) {
            const duplicate =
              claimErr.code === '23505' ||
              (claimErr.message ?? '').includes('duplicate key value');
            if (duplicate) {
              // Already sent this week — the whole point.
              skipped += 1;
              continue;
            }
            // Any OTHER claim failure fails OPEN on the MARKER, never on
            // the send: a missing table/permission blip must degrade to a
            // possible duplicate, not a fleet-wide digest outage (the
            // deploy-before-migrate class — see the account-disable
            // landmine). Reported so a silent duplicate-forever state is
            // visible.
            void reportError(new Error(claimErr.message ?? 'digest claim failed'), {
              tag: 'cron.weekly-digest.claim',
              extra: { orgId, userId },
            });
          }

          const html = renderWeeklyDigestHtml(payload, {
            ...opts,
            recipientName: name,
            now: runStartedAt,
            timeZone: group.timeZone,
          });
          const text = weeklyDigestText(payload, opts);
          // RFC 8058 List-Unsubscribe header. Until a dedicated
          // one-click endpoint ships, point at the in-app settings
          // page — that's the canonical place to flip the
          // email_digest_optin flag and Gmail / Apple Mail both
          // surface it as the inline "Unsubscribe" link.
          const res = await sendEmail({
            to,
            subject,
            html,
            text,
            from: DIGEST_FROM,
            headers: {
              'List-Unsubscribe': `<${settingsUrl}>`,
            },
          });
          if (res.ok) sent += 1;
          else {
            failed += 1;
            void reportError(new Error(res.error ?? 'send failed'), {
              tag: 'cron.weekly-digest.send',
              extra: { to, orgId },
            });
          }
        }
      } catch (orgErr) {
        // One bad org shouldn't kill the whole run.
        failed += group.recipients.length;
        void reportError(orgErr, {
          tag: 'cron.weekly-digest.org',
          extra: { orgId },
        });
      }
    }

    return NextResponse.json({ ok: true, sent, skipped, failed });
  } catch (err) {
    void reportError(err, { tag: 'cron.weekly-digest' });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'Digest run failed',
        sent,
        skipped,
        failed,
      },
      { status: 500 },
    );
  }
}
