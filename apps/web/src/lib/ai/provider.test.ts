import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Mutable env stand-in. resolveAiProvider reads env.ANTHROPIC_API_KEY and
 * env.AI_PROVIDER; each test sets exactly the two values it cares about.
 */
const mockEnv = vi.hoisted(
  () =>
    ({ ANTHROPIC_API_KEY: '', AI_PROVIDER: undefined }) as {
      ANTHROPIC_API_KEY: string;
      AI_PROVIDER?: 'claude' | 'gemini';
    },
);
vi.mock('@/lib/env', () => ({ env: mockEnv }));

import { resolveAiProvider } from './provider';

describe('resolveAiProvider (the Gemini→Claude switch)', () => {
  beforeEach(() => {
    mockEnv.ANTHROPIC_API_KEY = '';
    mockEnv.AI_PROVIDER = undefined;
  });

  it('defaults to gemini when no key and no override', () => {
    expect(resolveAiProvider()).toBe('gemini');
  });

  it('flips to claude the moment a key is present (no override needed)', () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    expect(resolveAiProvider()).toBe('claude');
  });

  it('AI_PROVIDER=gemini is the rollback lever — wins even with a key set', () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    mockEnv.AI_PROVIDER = 'gemini';
    expect(resolveAiProvider()).toBe('gemini');
  });

  it('AI_PROVIDER=claude without a key falls back to gemini (never 500 the AI)', () => {
    mockEnv.AI_PROVIDER = 'claude';
    expect(resolveAiProvider()).toBe('gemini');
  });

  it('AI_PROVIDER=claude with a key resolves to claude', () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    mockEnv.AI_PROVIDER = 'claude';
    expect(resolveAiProvider()).toBe('claude');
  });
});
