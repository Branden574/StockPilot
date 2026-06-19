import { describe, expect, it } from 'vitest';

import { __TEST__ } from './keyboard-shortcuts';

describe('keyboard shortcuts overlay', () => {
  it('documents the sidebar toggle (Cmd/Ctrl+\\)', () => {
    const row = __TEST__.SHORTCUT_ROWS.find((r) => r.keys.includes('\\'));
    expect(row).toBeTruthy();
    expect(row?.description.toLowerCase()).toContain('sidebar');
  });
});
