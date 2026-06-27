import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { sendEmail } from '@/lib/email/resend';
import {
  weeklyDigestHtml,
  weeklyDigestSubject,
  weeklyDigestText,
} from '@/lib/email/templates';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  applySectionOptIns,
  getDigestData,
  isDigestEmpty,
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
// Vercel default function timeout is 10s for Hobby. The cron iterates orgs
// + sends emails sequentially; bump generously since each Resend send is
// a network round trip.
export const maxDuration = 60;

/**
 * Weekly inventory digest. Wired to Vercel Cron via vercel.json
 * (0 14 * * 1 UTC ≈ 7am Pacific Mondays). Uses the service-role
 * client to span all orgs.
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
    type RecipientRow = {
      id: string;
      email: string;
      digest_section_low_stock: boolean | null;
      digest_section_open_pos: boolean | null;
      digest_section_cycle_counts: boolean | null;
      organization_members: Array<{
        organization_id: string;
        accepted_at: string | null;
        organizations:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }>;
    };

    const recipients = await fetchAllRows<RecipientRow>((from, to) =>
      admin
        .from('user_profiles')
        .select(
          `
        id, email,
        digest_section_low_stock,
        digest_section_open_pos,
        digest_section_cycle_counts,
        organization_members!inner (
          organization_id,
          accepted_at,
          organizations:organization_id (id, name)
        )
      `,
        )
        .eq('email_digest_optin', true)
        .not('organization_members.accepted_at', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    );

    interface RecipientLite {
      userId: string;
      email: string;
      sections: { lowStock: boolean; openPos: boolean; cycleCounts: boolean };
    }

    // Fan recipients out by org so each org's payload is computed once
    // even if multiple users in the same org are opted in.
    const byOrg = new Map<string, { orgName: string; recipients: RecipientLite[] }>();
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
          recipients: [],
        };
        if (!existing.recipients.some((r) => r.userId === row.id)) {
          existing.recipients.push({ userId: row.id, email: row.email, sections });
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
        const fullPayload = await getDigestData(admin, orgId);
        const opts = { orgName: group.orgName, appUrl, settingsUrl };
        for (const { userId, email: to, sections } of group.recipients) {
          // Re-check membership + opt-in IMMEDIATELY before sending.
          // The recipient set was assembled at the top of this run — for
          // a large fleet that gap can be tens of seconds. If the user
          // toggled the digest off, or was removed from the org, we
          // must not deliver. Two cheap point reads guard both axes:
          //   1) organization_members still active for (org, user)
          //   2) user_profiles.email_digest_optin still true
          const [membershipRes, profileRes] = await Promise.all([
            admin
              .from('organization_members')
              .select('user_id, accepted_at')
              .eq('organization_id', orgId)
              .eq('user_id', userId)
              .maybeSingle(),
            admin
              .from('user_profiles')
              .select('email_digest_optin')
              .eq('id', userId)
              .maybeSingle(),
          ]);
          const membership = membershipRes.data as
            | { user_id: string; accepted_at: string | null }
            | null;
          const profile = profileRes.data as { email_digest_optin: boolean | null } | null;
          if (!membership || !membership.accepted_at) {
            skipped += 1;
            continue;
          }
          if (!profile || profile.email_digest_optin === false) {
            skipped += 1;
            continue;
          }

          // Each recipient sees only their opted-in sections; one or two
          // could be all-empty even when the org's full payload isn't.
          const payload = applySectionOptIns(fullPayload, sections);
          if (isDigestEmpty(payload)) {
            skipped += 1;
            continue;
          }
          const html = weeklyDigestHtml(payload, opts);
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
