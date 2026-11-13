import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicMarkup } from '@/test/classic-parity';

/**
 * SETTINGS > APPEARANCE UNDER LIQUID GLASS (stage 3 fidelity check, small
 * lane, finding 5; Routes-Gallery-2's Appearance panel). Glass draws the
 * chosen option with the accent edge, the selection wash and the accent
 * radio, and Theme as a three-part segmented control, from inert hooks:
 *  - each option says whether it is chosen (data-glass-state on/off), and
 *    the hook follows the choice;
 *  - with every inert hook stripped the panel's markup is the file under
 *    __parity__, written from the panel before the hooks went in, so Classic
 *    draws exactly what it drew.
 * The panel exists only in a build that offers glass (the profile page
 * renders it only then), so it is tested under `default`.
 */

const { getMy, setMy } = vi.hoisted(() => ({ getMy: vi.fn(), setMy: vi.fn() }));
vi.mock('@/server/actions/appearance', () => ({
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
// The account read is a plain request (appearance-account-read.ts), never the
// read action: these tests answer it here.
vi.mock('@/components/theme/appearance-account-read', () => ({
  readAccountAppearance: (...a: unknown[]) => getMy(...a),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings/profile',
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AppearanceProvider } from '@/components/theme/appearance-provider';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { AppearancePanel } from './appearance-panel';

function Panel() {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        <div data-testid="panel">
          <AppearancePanel />
        </div>
      </AppearanceProvider>
    </ThemeProvider>
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });
const optionOf = (name: string) => radio(name).closest('label')!;
const state = (el: Element | null) => el?.getAttribute('data-glass-state');

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  getMy.mockResolvedValue({ ok: true, userId: null, row: null });
  setMy.mockResolvedValue({ ok: false });
  localStorage.setItem('theme', 'light');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  for (const name of ['data-appearance', 'data-lg-material', 'class', 'style']) {
    document.documentElement.removeAttribute(name);
  }
});

describe('the Appearance panel’s glass hooks', () => {
  it('the chosen Design and Theme say on, the others off; the radio dots follow', async () => {
    render(<Panel />);
    await waitFor(() => expect(radio('Liquid Glass')).toBeChecked());
    await waitFor(() => expect(radio('Light')).toBeChecked());
    expect(optionOf('Liquid Glass').getAttribute('data-glass')).toBe('appearance-choice');
    expect(state(optionOf('Liquid Glass'))).toBe('on');
    expect(state(optionOf('Classic'))).toBe('off');
    expect(state(optionOf('Liquid Glass').querySelector('[data-glass="radio-dot"]'))).toBe('on');
    expect(state(optionOf('Classic').querySelector('[data-glass="radio-dot"]'))).toBe('off');

    const seg = optionOf('Light').parentElement!;
    expect(seg.getAttribute('data-glass')).toBe('appearance-seg');
    expect([...seg.children].map((l) => l.getAttribute('data-glass'))).toEqual([
      'appearance-seg-item',
      'appearance-seg-item',
      'appearance-seg-item',
    ]);
    expect([...seg.children].map(state)).toEqual(['on', 'off', 'off']);
  });

  it('the hooks move with the choice', async () => {
    render(<Panel />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    fireEvent.click(radio('System'));
    await waitFor(() => expect(radio('System')).toBeChecked());
    expect(state(optionOf('System'))).toBe('on');
    expect(state(optionOf('Light'))).toBe('off');
    fireEvent.click(radio('Classic'));
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(state(optionOf('Classic'))).toBe('on');
    expect(state(optionOf('Liquid Glass'))).toBe('off');
  });

  it('with the inert hooks stripped, the markup is the panel’s classic markup (Liquid Glass and Light chosen)', async () => {
    render(<Panel />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    await expect(classicMarkup(screen.getByTestId('panel'))).toMatchFileSnapshot(
      './__parity__/appearance-panel.html',
    );
  });

  it('… and with Classic and Dark chosen', async () => {
    render(<Panel />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    fireEvent.click(radio('Classic'));
    fireEvent.click(radio('Dark'));
    await waitFor(() => expect(radio('Dark')).toBeChecked());
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    await expect(classicMarkup(screen.getByTestId('panel'))).toMatchFileSnapshot(
      './__parity__/appearance-panel-classic-dark.html',
    );
  });
});
