import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { claudeGenerateText } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { lookupUpc, buildAiDescriptionPrompt } from '@/lib/upc-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const enableAi = Boolean(env.GEMINI_API_KEY);
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
