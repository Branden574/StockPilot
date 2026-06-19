import { timingSafeEqual } from 'node:crypto';
import * as tls from 'node:tls';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { daysUntilExpiry, isCertExpiringSoon } from '@/server/security/monitors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
 * Connects to the app's public hostname on port 443 and reads the TLS
 * certificate's `valid_to` field. Resolves to the cert's `valid_to` string,
 * or rejects on connection failure / timeout.
 */
function fetchCertValidTo(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`TLS handshake timed out after 10s (host=${host})`));
    }, 10_000);

    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      clearTimeout(timeout);
      try {
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to;
        socket.end();
        if (!validTo) {
          reject(new Error(`No valid_to found in peer certificate (host=${host})`));
        } else {
          resolve(validTo);
        }
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Daily SSL/TLS certificate expiry monitor. Checks the app's public hostname
 * and alerts via the Slack error feed (reportError) when ≤ 30 days remain or
 * the cert cannot be read.
 *
 * Schedule: 0 9 * * * (daily at 09:00 UTC) — see vercel.json.
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

  // Derive hostname from NEXT_PUBLIC_APP_URL (e.g. "https://stockpilotusa.com")
  let host = 'stockpilotusa.com';
  try {
    const raw = env.NEXT_PUBLIC_APP_URL;
    if (raw) {
      host = new URL(raw).hostname;
    }
  } catch {
    // Leave default host; env value may be malformed
  }

  let validTo: string | null = null;
  let daysLeft: number | null = null;

  try {
    validTo = await fetchCertValidTo(host);
    const now = new Date();
    daysLeft = daysUntilExpiry(validTo, now);

    if (isCertExpiringSoon(validTo, now)) {
      void reportError(
        new Error(`TLS certificate for ${host} expires in ${daysLeft} day(s)`),
        {
          tag: 'cron.ssl-expiry',
          level: 'warning',
          extra: { host, validTo, daysLeft },
        },
      );
      return NextResponse.json({ host, validTo, daysLeft, status: 'expiring' });
    }

    return NextResponse.json({ host, validTo, daysLeft, status: 'ok' });
  } catch (err) {
    void reportError(err, {
      tag: 'cron.ssl-expiry',
      level: 'warning',
      extra: { host, validTo, daysLeft },
    });
    return NextResponse.json({ host, validTo, daysLeft, status: 'error' }, { status: 500 });
  }
}
