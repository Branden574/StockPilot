import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { claudeGenerateText } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { lookupUpc, buildAiDescriptionPrompt } from '@/lib/upc-lookup';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
} from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// UPC/AI lookup — an external + model round-trip that can exceed the ~15s
// default. (Not under a vercel.json functions glob.)
export const maxDuration = 60;

/**
 * UPC enrichment endpoint. Mobile/desktop call this AFTER the local
 * /api/v1/items/lookup misses, to try external sources for product
 * info (name, description, model number, image) so a new item can be
 * pre-filled instead of typed by hand.
 *
 * Chain: local DB (existsInInventory hint) → UPCitemdb free trial →
 * Gemini description fallback when name+brand exist but description
 * is empty. AI never invents identity (name/brand/model).
 *
 * Query: ?upc=<code>
 *   200 → { source, existsInInventory, itemId?, enrichment }
 *   404 → { error: 'not_found' }
 *   400 → { error: 'upc is required' }
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // MED-20, part 1: permission gate. This endpoint exists to PRE-FILL a new
  // item from a scanned barcode, so items:create is the capability it serves —
  // and it spends money (UPCitemdb + a model call) on every request, which is
  // not something a viewer should be able to do. It previously had only a rate
  // limit, which bounds the spend per minute without deciding who may spend.
  try {
    assertPermission(ctx, 'items:create');
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    throw e;
  }

  // MED-20, part 2: the 'ai' module gates the AI DESCRIPTION FALLBACK ONLY,
  // not the whole endpoint.
  //
  // Deliberate deviation from a blanket assertModuleEnabled: the primary path
  // here (local DB short-circuit, then UPCitemdb) contains no AI at all, so
  // failing the whole request would break plain barcode enrichment for every
  // org that has not bought the AI module — a functional regression, not a
  // security fix. Gating the model call is what actually stops an org without
  // the AI entitlement from reaching a model. assertModuleEnabled stays the
  // single source of truth for the decision (it also honours core-tier
  // modules); only the response to a failure differs.
  let aiModuleEnabled = true;
  try {
    assertModuleEnabled(ctx, 'ai');
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'module_disabled') {
      aiModuleEnabled = false;
    } else {
      throw e;
    }
  }

  // Per-user throttle: this calls paid external APIs (UPCitemdb + Gemini).
  // 60/min is generous for rapid barcode scanning but caps a runaway loop or a
  // compromised token from burning quota. Fail-open (authenticated surface).
  const rl = await checkRateLimit(`upc-lookup:user:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many lookups — slow down a moment.' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const url = new URL(req.url);
  const upc = (url.searchParams.get('upc') ?? '').trim();
  if (!upc) {
    return NextResponse.json({ error: 'upc is required' }, { status: 400 });
  }

  // Local short-circuit — if we already have it, return the row so the
  // caller can skip the external hop entirely.
  const safe = upc.replace(/[%,()]/g, '');
  const { data: local } = await ctx.supabase
    .from('inventory_items')
    .select('id, name, description, barcode, model_number')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .eq('barcode', safe)
    .limit(1)
    .maybeSingle();

  if (local) {
    return NextResponse.json({
      source: 'local',
      existsInInventory: true,
      itemId: local.id,
      enrichment: {
        name: local.name,
        description: local.description ?? null,
        brand: null,
        modelNumber: local.model_number ?? null,
        imageUrl: null,
      },
    });
  }

  try {
    // Needs BOTH a key and the org's AI entitlement (MED-20, part 2).
    const enableAi = Boolean(env.GEMINI_API_KEY) && aiModuleEnabled;
    const result = await lookupUpc(upc, {
      enableAiFallback: enableAi,
      describeWithAi: enableAi ? describeWithGemini : undefined,
    });

    if (result.source === 'not_found' || !result.enrichment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({
      source: result.source,
      existsInInventory: false,
      enrichment: result.enrichment,
    });
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'items.upc-lookup',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Description-only model call. The prompt is built so the model never
 * has to guess identifying details — it just paraphrases the name/brand
 * it was handed. Routes to Claude when configured (see lib/ai/provider).
 */
async function describeWithGemini(name: string, brand: string | null): Promise<string> {
  const prompt = buildAiDescriptionPrompt(name, brand);
  if (resolveAiProvider() === 'claude') {
    if (!env.ANTHROPIC_API_KEY) return '';
    return claudeGenerateText({ prompt, maxTokens: 512 });
  }
  if (!env.GEMINI_API_KEY) return '';
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const resp = await model.generateContent(prompt);
  return resp.response.text().trim();
}
