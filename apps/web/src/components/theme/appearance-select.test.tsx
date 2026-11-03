import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The header appearance menu (Liquid Glass plan D1; brief section 4): the four
 * choices as words, the one in use announced as checked, operable from the
 * keyboard, and Liquid Glass offered only when the build's kill switch is on.
 */

vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: vi.fn(),
  setMyAppearanceAction: vi.fn(),
}));

import { appearanceStatusText } from './appearance-select';
import { AppearanceProvider } from './appearance-provider';
import { ThemeProvider } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

function Header() {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        <ThemeToggle />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
  document.cookie = 'sp_appearance=; path=/; max-age=0';
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});

describe('the header appearance menu', () => {
  it('keeps its trigger, lists the four choices as words and marks the one in use', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Dark', 'true'],
      ['Light', 'false'],
      ['Liquid Glass', 'false'],
      ['System', 'false'],
    ]);
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('chooses Liquid Glass from the keyboard', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    screen.getByRole('button', { name: 'Toggle theme' }).focus();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('menuitemradio');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: 'Liquid Glass' })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass'),
    );
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('offers no Liquid Glass when the build does not', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Dark', 'Light', 'System']);
  });
});

describe('the account line', () => {
  it('never claims the account holds the choice unless the server said so', () => {
    expect(appearanceStatusText('synced')).toBe('Saved to your account.');
    for (const status of ['saving', 'failed', 'unavailable', 'signed-out'] as const) {
      expect(appearanceStatusText(status)).not.toMatch(/Saved to your account\./);
    }
    expect(appearanceStatusText('idle')).toBeNull();
    expect(appearanceStatusText(null)).toBeNull();
  });
});
