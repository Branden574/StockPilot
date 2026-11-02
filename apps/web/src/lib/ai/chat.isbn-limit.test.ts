import { describe, expect, it, vi } from 'vitest';

// tools.ts pulls in the whole service layer; none of it runs here.
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: 'test-model',
    ANTHROPIC_API_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));

import { ASSISTANT_ISBN_LIMIT } from '@/lib/books/import-limits';

import { SYSTEM_PROMPT } from './chat';
import { TOOL_CATALOG } from './tools';

/**
 * The assistant's ISBN limit, as the model is told it (docket B76). The
 * preview tool refuses more than ASSISTANT_ISBN_LIMIT ISBNs per call
 * (books-import.ts), and the web chat panel checks an attached file against
 * the same number. The tool description and the system prompt each typed 50,
 * and the prompt's "If 50+ ISBNs" sent a typed list of exactly 50 to Bulk ISBN
 * import although the tool takes 50. Both now read the constant, so a new
 * limit reaches every copy.
 */

describe("what the model is told about the assistant's ISBN limit (B76)", () => {
  it('the prompt sends a typed list to Bulk ISBN import only past the limit', () => {
    expect(SYSTEM_PROMPT).toContain(
      `If more than ${ASSISTANT_ISBN_LIMIT} ISBNs, recommend /dashboard/books/import`,
    );
    expect(SYSTEM_PROMPT).not.toContain('50+ ISBNs');
  });

  it('the preview tool states the same limit', () => {
    expect(TOOL_CATALOG['previewBulkBookImport']!.declaration.description).toContain(
      `Capped at ${ASSISTANT_ISBN_LIMIT} ISBNs per call; route larger batches to /dashboard/books/import.`,
    );
  });
});
