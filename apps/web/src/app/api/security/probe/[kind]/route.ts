import { isSecurityProbeKind } from '@stockpilot/core';

import { probeSampleOf } from '@/lib/security/probe-sample';
import { recordSecurityEventSample } from '@/server/security/event-samples';
import { recordSecurityEvent } from '@/server/security/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where next.config.ts sends a scanner path (lib/security/probe-paths.ts):
 * /.env, /.git/config, /wp-login.php and the like, addresses no page of this
 * app has. Every method answers a plain-text 404 "Not found" that is never
 * cached, the same for every kind and every method: nothing is served and
 * nothing about the kind is said. A
 * request whose kind is one of the probe kinds is also recorded as a security
 * event (exploit / blocked / <kind>, from the web) with the request's place
 * and day-keyed source hash, never its path or address. A request made to
 * this route directly with any other kind records nothing.
 *
 * WHAT WAS ASKED FOR (security tools part 5, stage 3): beside the event, a
 * sample of the request is recorded (server/security/event-samples.ts): its
 * method, its path and its query string as the client sent them, scrubbed
 * (@stockpilot/core request-scrub.ts), and its country. Never its address, a
 * header value, a cookie or a body. lib/security/probe-sample.ts decides
 * whether there is one at all: only when the rule Next applied to the path is
 * of this kind (so a direct call to this route keeps nothing), and never
 * under a path that can carry a token or key. The sample never changes the
 * answer and is never waited on.
 *
 * No session is read and nothing of any organization: neither the event nor
 * the sample has an organization.
 */
type ProbeContext = { params: Promise<{ kind: string }> };

async function answer(req: Request, { params }: ProbeContext): Promise<Response> {
  const { kind } = await params;
  if (isSecurityProbeKind(kind)) {
    // recordSecurityEvent never throws and only adds to the instance's
    // buffer; the write happens later, in one call for many events.
    await recordSecurityEvent(
      { category: 'exploit', outcome: 'blocked', reason: kind, source: 'web' },
      req.headers,
    );
    // What was asked for: never throws, returns nothing to wait on, and
    // nothing here can change the answer below.
    try {
      const sample = probeSampleOf(req, kind);
      if (sample !== null) recordSecurityEventSample(sample, req.headers);
    } catch {
      // A sample is never the caller's problem.
    }
  }
  return new Response(req.method === 'HEAD' ? null : 'Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function HEAD(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function OPTIONS(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function POST(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function PUT(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function PATCH(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
export async function DELETE(req: Request, ctx: ProbeContext) {
  return answer(req, ctx);
}
