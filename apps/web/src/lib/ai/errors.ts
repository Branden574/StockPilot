import 'server-only';

/**
 * Classify a Google Generative AI / network error into a small set of
 * user-facing codes. The point is: never show users the raw URL-laden
 * SDK message ("Error fetching from https://...:generateContent: [429
 * Too Many Requests] Your prepayment credits are depleted. Please go
 * to..."). They get a sentence; admins see the full thing in logs.
 *
 * Codes:
 *   - billing     — project is out of paid credits / billing issue
 *   - rate_limit  — RPM or RPD quota tripped
 *   - auth        — API key missing/invalid/restricted
 *   - safety      — prompt blocked by Google's content filter
 *   - transient   — Google-side outage / 5xx / network blip
 *   - unknown     — fallback for anything we couldn't classify
 *
 * Status codes mirror the underlying HTTP semantics so the client can
 * choose between toast vs. inline message vs. retry.
 */

export type AiErrorCode =
  | 'billing'
  | 'rate_limit'
  | 'auth'
  | 'safety'
  | 'transient'
  | 'unknown';

export interface ClassifiedAiError {
  code: AiErrorCode;
  /** Short sentence safe to show end users. No URLs, no SDK names. */
  userMessage: string;
  /** HTTP status the API route should return. */
  status: number;
}

const FALLBACK: ClassifiedAiError = {
  code: 'unknown',
  userMessage:
    "The AI assistant ran into a problem. Try again in a moment — if it keeps happening, contact your admin.",
  status: 500,
};

export function classifyAiError(err: unknown): ClassifiedAiError {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const text = raw.toLowerCase();

  // Order matters: billing-specific 429s come before generic rate-limit
  // 429s, otherwise "credits depleted" gets mis-tagged.
  if (
    text.includes('prepayment credit') ||
    text.includes('credits are depleted') ||
    text.includes('billing') ||
    text.includes('payment_required') ||
    // Parens are load-bearing: without them && binds tighter than ||
    // and the previous reader had to mentally re-precedence the line.
    (text.includes('insufficient') && text.includes('credit'))
  ) {
    return {
      code: 'billing',
      userMessage:
        "The AI assistant is temporarily unavailable — billing needs attention. Please contact your admin.",
      status: 503,
    };
  }

  if (
    text.includes('429') ||
    text.includes('too many requests') ||
    text.includes('resource_exhausted') ||
    text.includes('rate limit') ||
    text.includes('quota')
  ) {
    return {
      code: 'rate_limit',
      userMessage:
        "Too many requests right now. Try again in a moment.",
      status: 429,
    };
  }

  if (
    text.includes('api_key_invalid') ||
    text.includes('api key not valid') ||
    text.includes('permission_denied') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('gemini_api_key is not set')
  ) {
    return {
      code: 'auth',
      userMessage:
        "The AI assistant isn't configured. Please contact your admin.",
      status: 503,
    };
  }

  if (
    text.includes('safety') ||
    text.includes('blocked') ||
    text.includes('prohibited_content') ||
    text.includes('harm_category')
  ) {
    return {
      code: 'safety',
      userMessage:
        "I can't answer that one — try rephrasing your question.",
      status: 400,
    };
  }

  if (
    text.includes('503') ||
    text.includes('unavailable') ||
    text.includes('overloaded') ||
    text.includes('500') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('fetch failed')
  ) {
    return {
      code: 'transient',
      userMessage:
        "The AI service is having a hiccup. Try again in a few seconds.",
      status: 503,
    };
  }

  return FALLBACK;
}
