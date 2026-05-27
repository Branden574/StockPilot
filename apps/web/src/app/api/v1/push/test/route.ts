import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { notifyUser } from '@/server/services/push';

export const runtime = 'nodejs';

/**
 * Self-service push test endpoint. Authenticated callers can fire a
 * notification at their OWN registered devices to verify Expo Push
 * delivery is working end-to-end. Does NOT accept a target user_id —
 * that would let anyone spam anyone else.
 *
 * Optional body: { title?: string, body?: string, link?: string }.
 * All fields default; useful for the "tap to send myself a test"
 * affordance in mobile Settings.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: { title?: string; body?: string; link?: string } = {};
  try {
    if (req.headers.get('content-type')?.includes('application/json')) {
      body = (await req.json()) as typeof body;
    }
  } catch {
    // Empty body is fine — defaults below.
  }

  const delivered = await notifyUser({
    userId: ctx.userId,
    title: body.title ?? 'StockPilot — test push',
    body: body.body ?? 'If you can see this on your phone, push delivery is working.',
    link: body.link,
  });

  return NextResponse.json({ delivered });
}
