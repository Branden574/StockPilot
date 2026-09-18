import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { computeSeenViewedMap } from '@/lib/onboarding/announcement-logic';
import { legacyAnnouncementsFor } from '@/lib/releases/logic';
import { RELEASES } from '@/lib/releases/registry';
import { releaseViewerFor } from '@/server/services/releases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "What's New" — the Bearer twin of the web server actions
 * (getUnseenAnnouncementsAction / recordAnnouncementsSeenAction in
 * lib/onboarding/actions.ts). BOTH paths call the SAME pure logic
 * (announcement-logic.ts) so the two platforms stay byte-identical on the
 * quirks that matter (role filter, slice(0,3) in registry order, roles stripped
 * before leaving the server, all:true stamps the ENTIRE registry, preserve-
 * don't-overwrite merge) — critical because both write the same
 * user_onboarding.viewed_announcements row.
 *
 * CONTENT now comes from the release registry (lib/releases/registry.ts) through
 * legacyAnnouncementsFor, which returns EXACTLY the shape this route has always
 * returned: { id, date, title, body, cta? }, every field a string, capped at 3,
 * in registry order. Binaries already installed render those fields straight
 * into <Text> with no validation, and an OTA cannot reach a binary on an older
 * runtime, so this contract is frozen.
 *
 * Reach is now roles AND permissions AND enabled modules, not roles alone, so a
 * phone is no longer told about a page that would bounce it home.
 *
 * "Seen" here is the legacy viewed_announcements map and stays separate from
 * the web's read state (user_release_state) on purpose: every close on a phone
 * posts all:true, which stamps the whole registry, and that must not mark
 * everything read on the web.
 *
 * Role gating stays SERVER-SIDE: withApiContext re-derives ctx.role from
 * organization_members via the Bearer token, so role-gated announcement copy
 * (e.g. the backorders release, owner/admin/manager only) never reaches an
 * unentitled device — matching the web action and this codebase's posture that
 * gating is enforced server-side, client state is cosmetic.
 */

/** GET — role-filtered, unseen, newest-first, capped at 3, `roles` stripped. */
export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { data } = await ctx.supabase
      .from('user_onboarding')
      .select('viewed_announcements')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const viewed = (data?.viewed_announcements as Record<string, unknown> | null) ?? {};
    return NextResponse.json(
      { items: legacyAnnouncementsFor(RELEASES, releaseViewerFor(ctx), viewed) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    // Fail-quiet — What's New must never break the shell. Empty = show nothing.
    return NextResponse.json({ items: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

const seenSchema = z.object({
  ids: z.array(z.string().min(1).max(80)).min(1).max(50),
  outcome: z.enum(['seen', 'dismissed']),
  /** Close = "I'm caught up": stamp the WHOLE registry, not just the shown 1–3. */
  all: z.boolean().optional(),
});

/** POST — record announcements seen (mirrors recordAnnouncementsSeenAction). */
export async function POST(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = seenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }
  try {
    const { data: row } = await ctx.supabase
      .from('user_onboarding')
      .select('viewed_announcements')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const current = (row?.viewed_announcements as Record<string, unknown> | null) ?? {};
    const viewedMap = computeSeenViewedMap(
      current,
      parsed.data.ids,
      parsed.data.outcome,
      parsed.data.all ?? false,
      RELEASES.filter((r) => r.status === 'published').map((r) => r.id),
      new Date().toISOString(),
    );
    await ctx.supabase.from('user_onboarding').upsert(
      {
        user_id: ctx.userId,
        role_at_onboarding: ctx.role,
        viewed_announcements: viewedMap,
      },
      { onConflict: 'user_id' },
    );
    return NextResponse.json({ ok: true });
  } catch {
    // Best-effort — a lost mark just re-shows an announcement once next launch.
    return NextResponse.json({ ok: true });
  }
}
