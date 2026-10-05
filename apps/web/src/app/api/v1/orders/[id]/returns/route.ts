import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { parseReturnBody } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile (and Bearer) "Create return" on a completed order: the same service
 * call as the web action, RMAService.createFromOrder, which creates the
 * header, the lines and the created decision in ONE database transaction
 * (create_return_request, migration 0394) after the returns module,
 * returns:manage and write access to the order's warehouse.
 *
 * Body: core's create schema (whole units, 1 to 100 lines, at most 10,000 a
 * line), plus `idempotencyKey` (minted when the phone's sheet opens: a
 * resend of the same body replays the same RMA) and `itemIsHere` (the
 * counter switch, off by default). A body without a key (phones installed
 * before RX-1) gets a fresh key per request, exactly as safe as before.
 *
 * → 200 { ok: true, return: ReturnWithLines, replay }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle on top of the database gates.
  const rl = await checkRateLimit(`orders:returns:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'Invalid order id.' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'validation_error', message: 'Request body must be JSON.' }, { status: 400 });
  }
  // Older phones sent the disposition on every line and a numeric quantity;
  // a quantity that arrives as a numeric string is read as a number.
  const body = normalizeLegacyBody(raw);
  const parsed = parseReturnBody('create', body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.message, details: { reason: 'return_invalid' } },
      { status: 400 },
    );
  }

  try {
    const svc = RMAService.forApiContext(ctx);
    const created = await svc.createFromOrder(id, parsed.value, {
      idempotencyKey: parsed.value.idempotencyKey ?? null,
    });
    return NextResponse.json(
      { ok: true, return: created, replay: created.replay === true },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      if (e.code === 'internal_error') {
        void reportError(e, { tag: 'api.v1.orders.returns.create', organizationId: ctx.organizationId });
        return NextResponse.json(
          { error: 'internal_error', message: 'Something went wrong. Try again.', details: { reason: 'failed' } },
          { status: 500 },
        );
      }
      return NextResponse.json(
        { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.returns.create' });
    return NextResponse.json({ error: 'internal_error', details: { reason: 'failed' } }, { status: 500 });
  }
}

function normalizeLegacyBody(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.lines)) return raw;
  return {
    ...b,
    lines: b.lines.map((l) => {
      if (!l || typeof l !== 'object') return l;
      const line = l as Record<string, unknown>;
      const q = line.quantity;
      return typeof q === 'string' && /^\d+$/.test(q.trim()) ? { ...line, quantity: Number(q) } : line;
    }),
  };
}
