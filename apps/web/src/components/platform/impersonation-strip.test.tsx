import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The acting-as caution strip (matrix W-SH-06b; CONFLICTS D22). It keeps its
 * sentence and its Exit button word for word; the "⚠" glyph that led the
 * sentence is now an icon hidden from screen readers, so the warning is the
 * words plus a non-colour mark, never colour alone.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/platform/impersonation', () => ({ stopActingAsAction: vi.fn() }));

import { ImpersonationStrip } from './impersonation-strip';

describe('ImpersonationStrip', () => {
  it('keeps the sentence and the Exit button, with an icon in place of the glyph', () => {
    const { container } = render(<ImpersonationStrip />);
    expect(
      screen.getByText(
        'You are acting as another organization — you are viewing and editing their live data.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit — back to my workspace' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('⚠');
    const icon = container.querySelector('svg')!;
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
