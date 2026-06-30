/**
 * Signed, single-use OAuth `state` tokens for Zendesk (and future OAuth flows).
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 *
 * The payload embeds orgId, userId, platform, a 10-minute expiry (`exp`), and a
 * random `nonce`. The nonce makes every token unique so replayed tokens can be
 * detected by callers that implement a server-side nonce store. Phase 1 does NOT
 * require a server-side nonce store — the nonce is present so one can be added
 * later without a token format change.
 *
 * verifyState returns null on bad signature, length mismatch, expired token, or
 * any parse error — never throws.
 */
import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StatePayload {
  orgId: string;
  userId: string;
  platform: 'web' | 'mobile';
  exp: number;
  nonce: string;
}

function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Create a signed state token embedding orgId, userId, platform, a 10-minute
 * expiry, and a cryptographically random nonce.
 */
export function signState(payload: { orgId: string; userId: string; platform: 'web' | 'mobile' }): string {
  const full: StatePayload = {
    ...payload,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(16).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(full)).toString('base64url');
  const signature = hmac(env.OAUTH_STATE_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verify a signed state token. Returns the decoded { orgId, userId, platform }
 * on success, or null if the token is invalid (bad signature, tampered, expired,
 * or malformed).
 */
export function verifyState(state: string): { orgId: string; userId: string; platform: 'web' | 'mobile' } | null {
  try {
    const dotIndex = state.indexOf('.');
    if (dotIndex === -1) return null;

    const encodedPayload = state.slice(0, dotIndex);
    const receivedSig = state.slice(dotIndex + 1);

    // Recompute expected signature and compare lengths before timingSafeEqual
    // (timingSafeEqual throws on length mismatch — we must guard this).
    const expectedSig = hmac(env.OAUTH_STATE_SECRET, encodedPayload);
    const expectedBuf = Buffer.from(expectedSig);
    const receivedBuf = Buffer.from(receivedSig);

    if (expectedBuf.length !== receivedBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, receivedBuf)) return null;

    // Decode and parse the payload.
    const raw = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed: StatePayload = JSON.parse(raw) as StatePayload;

    // Reject expired tokens.
    if (parsed.exp < Date.now()) return null;

    return {
      orgId: parsed.orgId,
      userId: parsed.userId,
      platform: parsed.platform,
    };
  } catch {
    return null;
  }
}
