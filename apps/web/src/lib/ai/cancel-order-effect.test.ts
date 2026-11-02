import { describe, expect, it, vi } from 'vitest';

/**
 * B51: what the assistant is told a cancel does. The cancelOrder tool's
 * description said a cancel restores any stock picking pulled "so net
 * inventory effect is zero", and the chat rules said the same, by role and
 * citing a migration two rewrites old. cancel_order_request never puts back
 * in stock what was already delivered (handed over), at any status
 * (0395_order_stock_guards.sql; pgTAP 0290 D and E): it releases the stock
 * held for the order and restocks only what was picked and not yet handed
 * over. And an approver's cancel follows orders:approve, not a role. The
 * phone's AI chat calls the same /api/ai/chat, so these two texts are what
 * both assistants are told.
 */

vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
// tools.ts pulls in the whole service layer; none of it is exercised here, but
// it must import cleanly for TOOL_CATALOG and SYSTEM_PROMPT to be read.
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-2.0-flash',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));

import { SYSTEM_PROMPT } from './chat';
import { TOOL_CATALOG } from './tools';

/** The prompt's cancelOrder bullet, up to the next blank line. */
function cancelRule(): string {
  const start = SYSTEM_PROMPT.indexOf('- cancelOrder:');
  expect(start).toBeGreaterThan(-1);
  const end = SYSTEM_PROMPT.indexOf('\n\n', start);
  return SYSTEM_PROMPT.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

describe('what the assistant is told a cancel does (B51)', () => {
  it('the cancelOrder tool: delivered items are never put back in stock, never "net zero"', () => {
    const description = String(TOOL_CATALOG.cancelOrder?.declaration.description ?? '');
    expect(description).not.toMatch(/net inventory effect is zero/);
    expect(description).toContain(
      'Releases the stock held for it and puts back in stock what was picked for it and not yet handed over. Items already delivered (handed over) are never put back in stock.',
    );
    // The rest stays: the confirm rule and who may cancel.
    expect(description).toContain(
      'Use only AFTER the user has explicitly confirmed in the previous turn.',
    );
    expect(description).toContain(
      'anyone with the orders:approve permission can cancel any non-terminal order',
    );
  });

  it('the chat rule: by orders:approve, not a role, and delivered items are never put back in stock', () => {
    const rule = cancelRule();
    expect(rule).not.toContain('managers+ can cancel');
    expect(rule).not.toMatch(/0137/);
    expect(rule).not.toMatch(/restores any stock/i);
    expect(rule).toContain(
      'anyone with orders:approve can cancel any non-terminal order in a warehouse they work in.',
    );
    expect(rule).toContain('items already delivered are never put back in stock.');
    expect(rule).toContain('Terminal states (completed / denied / cancelled) are rejected.');
  });
});
