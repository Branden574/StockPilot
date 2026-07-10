import 'server-only';

import { env } from '@/lib/env';

/**
 * Which generative-AI provider serves this request.
 *
 * Rule (single source of truth for EVERY generative surface):
 *   - ANTHROPIC_API_KEY set AND AI_PROVIDER !== 'gemini'  → 'claude'
 *   - otherwise                                           → 'gemini'
 *
 * So flipping to Claude is "add the key" (nothing else), and the instant
 * rollback is AI_PROVIDER=gemini WITHOUT pulling the key (no redeploy of the
 * key material, just a one-var change). Embeddings are NOT routed here —
 * Anthropic has no embeddings API, so lib/ai/embeddings.ts always uses Gemini.
 */
export type AiProvider = 'claude' | 'gemini';

export function resolveAiProvider(): AiProvider {
  if (env.AI_PROVIDER === 'gemini') return 'gemini';
  if (env.AI_PROVIDER === 'claude') {
    // Explicitly requested Claude — honor it only if we actually have a key,
    // else fall back to Gemini rather than 500 every AI call.
    return env.ANTHROPIC_API_KEY ? 'claude' : 'gemini';
  }
  // Unset: presence of the key is the switch.
  return env.ANTHROPIC_API_KEY ? 'claude' : 'gemini';
}
