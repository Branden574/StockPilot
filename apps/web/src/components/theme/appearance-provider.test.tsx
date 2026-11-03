import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The appearance layer next to next-themes (Liquid Glass plan 1-3, 5.6, D12):
 * what a choice does to <html>, to next-themes, to the device and the account,
 * that switching never remounts the page, and the kill switch.
 */

const { getMy, setMy, toast } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { AppearancePanel } from '@/components/settings/appearance-panel';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

import { AppearanceAccountSync, AppearanceProvider } from './appearance-provider';
import { ThemeProvider } from './theme-provider';

const USER = '11111111-1111-4111-8111-111111111111';

let mounts = 0;
function Page() {
  React.useEffect(() => {
    mounts += 1;
  }, []);
  return <input aria-label="Unsaved note" defaultValue="" />;
}

function App({ userId }: { userId?: string }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        {userId ? <AppearanceAccountSync userId={userId} /> : null}
        <h2 id="appearance-heading">Appearance</h2>
        <AppearancePanel labelledBy="appearance-heading" />
        <Page />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

const html = () => document.documentElement;
const radio = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
  mounts = 0;
  getMy.mockReset();
  setMy.mockReset();
  toast.mockReset();
  getMy.mockResolvedValue({ ok: true, userId: USER, row: null });
  setMy.mockImplementation(
    async ({ userId, appearance }: { userId: string; appearance: string }) => ({
      ok: true,
      userId,
      row: { appearance, updated_at: '2026-11-02T10:00:00.000001+00:00' },
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_appearance=; path=/; max-age=0';
  html().removeAttribute('data-appearance');
  html().removeAttribute('class');
  html().removeAttribute('style');
});

describe('a classic person', () => {
  it('sees nothing change: no attribute, no cookie, no record, the theme kept', async () => {
    localStorage.setItem('theme', 'dark');
    render(<App />);
    await waitFor(() => expect(radio('Dark')).toBeChecked());
    expect(html().hasAttribute('data-appearance')).toBe(false);
    expect(document.cookie).not.toContain('sp_appearance');
    expect(localStorage.getItem('sp-appearance')).toBeNull();
    expect(localStorage.getItem('sp-appearance-sync')).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});

describe('choosing', () => {
  it('applies Liquid Glass at once, hands next-themes system, and remounts nothing', async () => {
    localStorage.setItem('theme', 'light');
    render(<App />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    const input = screen.getByRole('textbox', { name: 'Unsaved note' });
    fireEvent.change(input, { target: { value: 'half-typed' } });
    expect(mounts).toBe(1);

    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(html().getAttribute('data-appearance')).toBe('liquid-glass'));
    expect(localStorage.getItem('theme')).toBe('system');
    expect(document.cookie).toContain('sp_appearance=liquid-glass');
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toMatchObject({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'light',
    });

    fireEvent.click(radio('Dark'));
    await waitFor(() => expect(html().hasAttribute('data-appearance')).toBe(false));
    expect(localStorage.getItem('theme')).toBe('dark');

    // The same node, its typed value, one mount across every switch.
    expect(screen.getByRole('textbox', { name: 'Unsaved note' })).toBe(input);
    expect(input).toHaveValue('half-typed');
    expect(mounts).toBe(1);
  });

  it('signed out, keeps the choice on this device and says so', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Liquid Glass' }));
    expect(await screen.findByText('Saved on this device.')).toBeInTheDocument();
    expect(setMy).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('sp-appearance')!).anonAt).toEqual(expect.any(Number));
  });
});

describe('the account', () => {
  it('saves a signed-in choice to the person’s own row and says so only when the server answered', async () => {
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalledWith(USER));
    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() =>
      expect(setMy).toHaveBeenCalledWith({ userId: USER, appearance: 'liquid-glass' }),
    );
    expect(await screen.findByText('Saved to your account.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('sp-appearance-sync')!)).toMatchObject({
      userId: USER,
      dirty: false,
    });
  });

  it('a failed save stays on this device, says so truthfully and offers Try again', async () => {
    setMy.mockResolvedValueOnce({ ok: false, reason: 'error' });
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalled());
    fireEvent.click(radio('Dark'));
    expect(
      await screen.findByText('Saved on this device. Not saved to your account yet.'),
    ).toBeInTheDocument();
    expect(localStorage.getItem('theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Saved to your account.')).toBeInTheDocument();
    expect(setMy).toHaveBeenCalledTimes(2);
  });

  it('a missing account table says this device only', async () => {
    setMy.mockResolvedValue({ ok: false, reason: 'missing-table' });
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalled());
    fireEvent.click(radio('Light'));
    expect(await screen.findByText('Saved on this device only.')).toBeInTheDocument();
  });

  it('adopts the account’s choice on a device that never synced with this person', async () => {
    getMy.mockResolvedValue({
      ok: true,
      userId: USER,
      row: { appearance: 'liquid-glass', updated_at: '2026-11-02T10:00:00+00:00' },
    });
    render(<App userId={USER} />);
    await waitFor(() => expect(html().getAttribute('data-appearance')).toBe('liquid-glass'));
    expect(radio('Liquid Glass')).toBeChecked();
  });

  it('a late answer never overwrites a choice made after it started', async () => {
    let answer!: (v: unknown) => void;
    getMy.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalled());
    fireEvent.click(radio('Dark'));
    await act(async () => {
      answer({
        ok: true,
        userId: USER,
        row: { appearance: 'liquid-glass', updated_at: '2026-11-02T11:00:00+00:00' },
      });
    });
    expect(radio('Dark')).toBeChecked();
    expect(html().hasAttribute('data-appearance')).toBe(false);
  });
});

describe('the first-paint cookie', () => {
  it('is written again on load when it expired but this device still holds Liquid Glass', async () => {
    // Safari caps a script-written cookie at 7 days; localStorage outlives it.
    // Without the cookie the head script paints classic and glass arrives a
    // moment later, on every load, until the person chooses again.
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'light' }),
    );
    expect(document.cookie).not.toContain('sp_appearance=liquid-glass');
    render(<App />);
    await waitFor(() => expect(html().getAttribute('data-appearance')).toBe('liquid-glass'));
    expect(document.cookie).toContain('sp_appearance=liquid-glass');
  });

  it('is made to say what the device record says when the two disagree', async () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'dark', lastClassic: 'dark' }),
    );
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    render(<App />);
    await waitFor(() => expect(radio('Dark')).toBeChecked());
    expect(document.cookie).toContain('sp_appearance=dark');
    expect(document.cookie).not.toContain('sp_appearance=liquid-glass');
  });
});

describe('the kill switch (NEXT_PUBLIC_LIQUID_GLASS off)', () => {
  it('renders a stored Liquid Glass as classic System, removes the attribute, keeps the stored value and offers no glass', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'dark' }),
    );
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    html().setAttribute('data-appearance', 'liquid-glass');
    render(<App />);
    await waitFor(() => expect(html().hasAttribute('data-appearance')).toBe(false));
    expect(screen.queryByRole('radio', { name: 'Liquid Glass' })).toBeNull();
    expect(radio('System')).toBeChecked();
    expect(JSON.parse(localStorage.getItem('sp-appearance')!).mode).toBe('liquid-glass');
    expect(document.cookie).toContain('sp_appearance=liquid-glass');
  });
});

describe('the one-time crash fallback', () => {
  it('shows classic once with a notice, and leaves the stored choice alone', async () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'light' }),
    );
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    render(<App />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0]![0]).toBe(
      'Liquid Glass hit a problem, so StockPilot opened in the classic look.',
    );
    const options = toast.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
      cancel: { label: string };
    };
    expect(options.action.label).toBe('Turn Liquid Glass back on');
    expect(options.cancel.label).toBe('Use classic');
    expect(html().hasAttribute('data-appearance')).toBe(false);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('shown');
    expect(JSON.parse(localStorage.getItem('sp-appearance')!).mode).toBe('liquid-glass');

    act(() => options.action.onClick());
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });
});

describe('the one-time crash fallback in Settings', () => {
  it('marks what is on screen, not the stored choice, and choosing Liquid Glass turns it back on', async () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'light' }),
    );
    sessionStorage.setItem('sp-lg-fallback', 'shown');
    render(<App />);
    await waitFor(() => expect(radio('System')).toBeChecked());
    expect(radio('Liquid Glass')).not.toBeChecked();
    expect(html().hasAttribute('data-appearance')).toBe(false);

    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(html().getAttribute('data-appearance')).toBe('liquid-glass'));
    expect(radio('Liquid Glass')).toBeChecked();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });
});

describe('an open dialog survives every switch', () => {
  it('keeps the same dialog node, its typed value and its focus across Dark, Liquid Glass, Light, Dark', async () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <AppearanceProvider>
          <h2 id="appearance-heading">Appearance</h2>
          <AppearancePanel labelledBy="appearance-heading" />
          <Dialog open>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Hide items</DialogTitle>
              <input aria-label="Reason" defaultValue="" />
            </DialogContent>
          </Dialog>
        </AppearanceProvider>
      </ThemeProvider>,
    );
    // The modal hides the rest of the page from assistive tech; the choices
    // are reached here through that hidden tree (a person uses the account
    // menu). What matters is what the switch does to the open dialog.
    const choice = (name: string) => screen.getByRole('radio', { name, hidden: true });
    const dialog = await screen.findByRole('dialog');
    const reason = screen.getByRole('textbox', { name: 'Reason' }) as HTMLInputElement & {
      __lgProbe?: string;
    };
    reason.__lgProbe = 'token';
    fireEvent.change(reason, { target: { value: 'kept' } });
    reason.focus();
    await waitFor(() => expect(choice('Dark')).toBeChecked());

    for (const next of ['Liquid Glass', 'Light', 'Dark']) {
      fireEvent.click(choice(next));
      await waitFor(() => expect(choice(next)).toBeChecked());
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(dialog.isConnected).toBe(true);
      const now = screen.getByRole('textbox', { name: 'Reason' }) as typeof reason;
      expect(now).toBe(reason);
      expect(now.__lgProbe).toBe('token');
      expect(now).toHaveValue('kept');
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(html().hasAttribute('data-appearance')).toBe(false);
  });
});
