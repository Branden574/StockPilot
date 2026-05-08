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
import { getDigestData, isDigestEmpty } from '@/server/services/digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
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
  if (env.CRON_SECRET) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const admin = createAdminClient();

    // Pull every opted-in user along with their org membership + name. One
    // query — joins user_profiles → organization_members → organizations.
    const { data: recipients, error } = await admin
      .from('user_profiles')
      .select(
        `
        id, email,
        organization_members!inner (
          organization_id,
          accepted_at,
          organizations:organization_id (id, name)
        )
      `,
      )
      .eq('email_digest_optin', true)
      .not('organization_members.accepted_at', 'is', null);
    if (error) throw new Error(error.message);

    type RecipientRow = {
      id: string;
      email: string;
      organization_members: Array<{
        organization_id: string;
        accepted_at: string | null;
        organizations:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }>;
    };

    // Fan recipients out by org so each org's payload is computed once
    // even if multiple users in the same org are opted in.
    const byOrg = new Map<string, { orgName: string; emails: string[] }>();
    for (const row of (recipients ?? []) as RecipientRow[]) {
      for (const m of row.organization_members ?? []) {
        if (!m.accepted_at) continue;
        const orgRow = Array.isArray(m.organizations)
          ? m.organizations[0]
          : m.organizations;
        if (!orgRow) continue;
        const existing = byOrg.get(orgRow.id) ?? {
          orgName: orgRow.name,
          emails: [],
        };
        if (!existing.emails.includes(row.email)) existing.emails.push(row.email);
        byOrg.set(orgRow.id, existing);
      }
    }

    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    const settingsUrl = `${appUrl}/dashboard/settings/notifications`;
    const subject = weeklyDigestSubject();

    for (const [orgId, group] of byOrg) {
      try {
        const payload = await getDigestData(admin, orgId);
        if (isDigestEmpty(payload)) {
          // No "all clear" emails — empty digest = no send.
          skipped += group.emails.length;
          continue;
        }
        const opts = { orgName: group.orgName, appUrl, settingsUrl };
        const html = weeklyDigestHtml(payload, opts);
        const text = weeklyDigestText(payload, opts);
        for (const to of group.emails) {
          const res = await sendEmail({ to, subject, html, text });
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
        failed += group.emails.length;
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
