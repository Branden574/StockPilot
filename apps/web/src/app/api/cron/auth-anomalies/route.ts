import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { detectDeviceSpikes } from '@/server/security/monitors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How many new devices in 24 h triggers a spike alert */
const DEVICE_THRESHOLD = 4;

/** Look-back window in hours */
const WINDOW_HOURS = 24;

/** PostgREST max_rows cap; mirrors server/services/lib/paginate.ts PAGE_SIZE */
const PAGE_SIZE = 1000;

/**
 * Constant-time string compare. Matches cron/price-pull pattern.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Auth-anomaly monitor: queries `user_login_devices` for rows whose
 * `first_seen_at` is within the last 24 hours, groups by user_id, and alerts
 * (via reportError → Slack error feed) for any user who registered ≥ 4 new
 * devices in that window.
 *
 * Schedule: "0 *\/6 * * *" (every 6 hours) — see vercel.json.
 * Auth: Bearer ${CRON_SECRET} — fail-closed.
 */
export async function GET(req: Request) {
  // Fail-closed when CRON_SECRET is unset/empty. Matches cron/price-pull.
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Paginate over user_login_devices with first_seen_at in the last 24h.
  // A plain .select() is silently capped at PostgREST's 1000-row max, which
  // would miss rows once spike events become frequent.
  type DeviceRow = { user_id: string; first_seen_at: string; last_ip: string | null };
  const allRows: DeviceRow[] = [];

  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await admin
        .from('user_login_devices')
        .select('user_id, first_seen_at, last_ip')
        .gte('first_seen_at', new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString())
        .order('id', { ascending: true })
        .range(from, to);

      if (error) {
        void reportError(new Error(`auth-anomalies device query: ${error.message}`), {
          tag: 'cron.auth-anomaly',
        });
        return NextResponse.json({ error: 'query_failed' }, { status: 500 });
      }

      const page = (data ?? []) as DeviceRow[];
      for (const r of page) allRows.push(r);
      if (page.length < PAGE_SIZE) break;
    }

    const spikes = detectDeviceSpikes(allRows, DEVICE_THRESHOLD);

    for (const { userId, newDeviceCount, lastIp } of spikes) {
      void reportError(new Error('Auth anomaly: new device spike'), {
        tag: 'cron.auth-anomaly',
        level: 'warning',
        extra: { userId, newDeviceCount, lastIp },
      });
    }

    return NextResponse.json({
      windowHours: WINDOW_HOURS,
      threshold: DEVICE_THRESHOLD,
      checkedUsers: new Set(allRows.map((r) => r.user_id)).size,
      flagged: spikes.length,
    });
  } catch (err) {
    void reportError(err, { tag: 'cron.auth-anomaly' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
