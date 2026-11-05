import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The appearance layer next to next-themes (plans/REVISION-DEFAULT.md R1-R8,
 * R13; section 9 items 10 and 40): what a Design or Theme choice does to
 * <html>, to next-themes, to the device and the account; that glass is the
 * default under `default` and nothing writes a default; the print route; the
 * low-power material; the intro notice; that switching never remounts the
 * page; and the kill switch (inert under `off`).
 */

const { getMy, setMy, toast, nav, refresh } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  toast: vi.fn(),
  nav: { pathname: '/dashboard' },
  refresh: vi.fn(),
}));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh }),
}));

import { AppearancePanel } from '@/components/settings/appearance-panel';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

import {
  AppearanceAccountSync,
  AppearanceProvider,
  INTRO_NOTICE,
  MarketingVariantGuard,
  useAppearance,
  VARIANT_GUARD_TIMEOUT_MS,
} from './appearance-provider';
import { ThemeProvider } from './theme-provider';
import { EARLY_HIDE_ATTRIBUTE, twinFirstPaintScript } from './twin-first-paint';

const USER = '11111111-1111-4111-8111-111111111111';
const STAMP = '2026-11-02T10:00:00.000001+00:00';

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
        <AppearancePanel />
        <Page />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

const html = () => document.documentElement;
const glassOn = () => html().getAttribute('data-appearance') === 'liquid-glass';
const radio = (name: string) => screen.getByRole('radio', { name });
const record = () => JSON.parse(localStorage.getItem('sp-appearance') ?? 'null') as unknown;
let fetchMock: ReturnType<typeof vi.fn>;
const routeCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === '/api/appearance/style')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);

function setNavigator(deviceMemory: number | undefined, hardwareConcurrency = 8) {
  Object.defineProperty(window.navigator, 'deviceMemory', {
    configurable: true,
    get: () => deviceMemory,
  });
  Object.defineProperty(window.navigator, 'hardwareConcurrency', {
    configurable: true,
    get: () => hardwareConcurrency,
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  mounts = 0;
  nav.pathname = '/dashboard';
  refresh.mockReset();
  getMy.mockReset();
  setMy.mockReset();
  toast.mockReset();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  getMy.mockResolvedValue({ ok: true, userId: USER, row: null });
  setMy.mockImplementation(
    async ({ userId, style, theme }: { userId: string; style?: string; theme?: string }) => ({
      ok: true,
      userId,
      row: { style: style ?? null, theme: theme ?? null, updated_at: STAMP },
    }),
  );
  setNavigator(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  html().removeAttribute('data-appearance');
  html().removeAttribute('data-lg-material');
  html().removeAttribute('class');
  html().removeAttribute('style');
});

describe('default rollout: Liquid Glass is what a person sees first', () => {
  it('no cookie, no record: glass at once, Liquid Glass checked; nothing is written for a default', async () => {
    localStorage.setItem('theme', 'dark');
    render(<App />);
    await waitFor(() => expect(radio('Liquid Glass')).toBeChecked());
    expect(glassOn()).toBe(true);
    // Night glass: next-themes keeps the person's Dark.
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(radio('Dark')).toBeChecked();
    expect(document.cookie).not.toContain('sp_style');
    expect(localStorage.getItem('sp-appearance')).toBeNull();
    expect(routeCalls()).toEqual([]);
  });

  it('an existing Light choice becomes Day glass, nothing rewritten', async () => {
    localStorage.setItem('theme', 'light');
    render(<App />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    expect(glassOn()).toBe(true);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('choosing Classic: the attribute goes, the Theme stays, the cookie and record say classic, the server re-issues it, nothing remounts', async () => {
    localStorage.setItem('theme', 'light');
    render(<App />);
    await waitFor(() => expect(radio('Liquid Glass')).toBeChecked());
    const input = screen.getByRole('textbox', { name: 'Unsaved note' });
    fireEvent.change(input, { target: { value: 'half-typed' } });

    fireEvent.click(radio('Classic'));
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(radio('Classic')).toBeChecked();
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.cookie).toContain('sp_style=classic');
    expect(record()).toMatchObject({ v: 2, style: 'classic' });
    await waitFor(() => expect(routeCalls()).toEqual([{ style: 'classic' }]));

    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(glassOn()).toBe(true));
    // Choosing glass never hands next-themes 'system' (R2).
    expect(localStorage.getItem('theme')).toBe('light');

    expect(screen.getByRole('textbox', { name: 'Unsaved note' })).toBe(input);
    expect(input).toHaveValue('half-typed');
    expect(mounts).toBe(1);
  });

  it('choosing a Theme hands next-themes that Theme, keeps the Design, and writes no Design cookie', async () => {
    localStorage.setItem('theme', 'light');
    render(<App />);
    await waitFor(() => expect(radio('Light')).toBeChecked());
    fireEvent.click(radio('Dark'));
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('dark'));
    expect(radio('Dark')).toBeChecked();
    expect(glassOn()).toBe(true);
    expect(record()).toEqual(expect.objectContaining({ v: 2, theme: 'dark' }));
    expect((record() as { style?: string }).style).toBeUndefined();
    expect(document.cookie).not.toContain('sp_style');
  });

  it('a stored Classic with its cookie: classic, and the matching cookie is not written again', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    localStorage.setItem('sp-style-server-at', String(Date.now()));
    document.cookie = 'sp_style=classic; path=/';
    render(<App />);
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(glassOn()).toBe(false);
    expect(routeCalls()).toEqual([]);
  });

  it('a stored Classic whose cookie expired: the cookie is repaired and the server asked once', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    render(<App />);
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(document.cookie).toContain('sp_style=classic');
    await waitFor(() => expect(routeCalls()).toEqual([{ style: 'classic' }]));
  });

  it('signed out, keeps the choice on this device, stamps this tab’s flow, and says so', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Classic' }));
    expect(await screen.findByText('Saved on this device.')).toBeInTheDocument();
    expect(setMy).not.toHaveBeenCalled();
    expect((record() as { anonAt?: number }).anonAt).toEqual(expect.any(Number));
    expect(JSON.parse(sessionStorage.getItem('sp-appearance-anon')!)).toMatchObject({
      v: 1,
      axes: ['style'],
    });
  });
});

describe('opt-in rollout', () => {
  it('classic unless the person chose Liquid Glass', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    render(<App />);
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(glassOn()).toBe(false);
    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(glassOn()).toBe(true));
    expect(document.cookie).toContain('sp_style=liquid-glass');
  });
});

describe('the print route (R6)', () => {
  it('is never glass on a hard load, and a client navigation into and out of it flips the attribute', async () => {
    nav.pathname = '/dashboard/orders/abc/print';
    const { rerender } = render(<App />);
    await waitFor(() => expect(radio('Liquid Glass')).toBeChecked());
    expect(glassOn()).toBe(false);

    nav.pathname = '/dashboard/orders/abc';
    rerender(<App />);
    expect(glassOn()).toBe(true);

    nav.pathname = '/dashboard/orders/abc/print';
    rerender(<App />);
    expect(glassOn()).toBe(false);
  });
});

describe('the low-power material (R7)', () => {
  it('is set with glass on a weak Chromium browser and removed with it', async () => {
    setNavigator(2, 8);
    render(<App />);
    await waitFor(() => expect(glassOn()).toBe(true));
    expect(html().getAttribute('data-lg-material')).toBe('reduced');
    fireEvent.click(radio('Classic'));
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(html().hasAttribute('data-lg-material')).toBe(false);
  });

  it('never without deviceMemory (Safari, Firefox, iOS)', async () => {
    setNavigator(undefined, 1);
    render(<App />);
    await waitFor(() => expect(glassOn()).toBe(true));
    expect(html().hasAttribute('data-lg-material')).toBe(false);
  });
});

describe('the account', () => {
  it('saves only the axis chosen to the person’s own row, and says so only when the server answered', async () => {
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalledWith(USER));
    fireEvent.click(radio('Classic'));
    await waitFor(() => expect(setMy).toHaveBeenCalledWith({ userId: USER, style: 'classic' }));
    expect(await screen.findByText('Saved to your account.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('sp-appearance-sync')!)).toEqual({
      v: 2,
      userId: USER,
      dirtyAxes: [],
      syncedAt: STAMP,
    });
    fireEvent.click(radio('Dark'));
    await waitFor(() => expect(setMy).toHaveBeenLastCalledWith({ userId: USER, theme: 'dark' }));
  });

  it('adopts the account’s Design and Theme on a device that never synced with this person', async () => {
    localStorage.setItem('theme', 'light');
    getMy.mockResolvedValue({
      ok: true,
      userId: USER,
      row: { style: 'classic', theme: 'dark', updated_at: STAMP },
    });
    render(<App userId={USER} />);
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(glassOn()).toBe(false);
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('dark'));
    expect(record()).toMatchObject({ v: 2, style: 'classic', theme: 'dark' });
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

  it('a late answer never overwrites a choice made after it started', async () => {
    let answer!: (v: unknown) => void;
    getMy.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalled());
    fireEvent.click(radio('Classic'));
    await act(async () => {
      answer({
        ok: true,
        userId: USER,
        row: { style: 'liquid-glass', theme: null, updated_at: '2026-11-02T11:00:00+00:00' },
      });
    });
    expect(radio('Classic')).toBeChecked();
    expect(glassOn()).toBe(false);
  });
});

describe('the one-time intro notice (R13)', () => {
  type Options = {
    action: { label: string; onClick: () => void };
    cancel: { label: string; onClick: () => void };
    onDismiss: () => void;
    duration: number;
  };
  const introCalls = () => toast.mock.calls.filter(([text]) => text === INTRO_NOTICE);

  it('signed in, never chose, account read: once, with Use classic design and Keep Liquid Glass', async () => {
    render(<App userId={USER} />);
    await waitFor(() => expect(introCalls()).toHaveLength(1));
    const options = introCalls()[0]![1] as Options;
    expect(INTRO_NOTICE).toBe(
      'StockPilot has a new look. You can switch back to the classic design at any time.',
    );
    expect(options.duration).toBe(Infinity);
    expect(options.action.label).toBe('Use classic design');
    expect(options.cancel.label).toBe('Keep Liquid Glass');

    act(() => options.action.onClick());
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(localStorage.getItem('sp-lg-intro-seen')).not.toBeNull();
    await waitFor(() => expect(setMy).toHaveBeenCalledWith({ userId: USER, style: 'classic' }));
  });

  it('Keep Liquid Glass makes the Design the person’s own and saves it', async () => {
    render(<App userId={USER} />);
    await waitFor(() => expect(introCalls()).toHaveLength(1));
    act(() => (introCalls()[0]![1] as Options).cancel.onClick());
    await waitFor(() =>
      expect(setMy).toHaveBeenCalledWith({ userId: USER, style: 'liquid-glass' }),
    );
    expect(record()).toMatchObject({ style: 'liquid-glass' });
    expect(glassOn()).toBe(true);
  });

  it('closing it marks it seen without choosing', async () => {
    render(<App userId={USER} />);
    await waitFor(() => expect(introCalls()).toHaveLength(1));
    act(() => (introCalls()[0]![1] as Options).onDismiss());
    expect(localStorage.getItem('sp-lg-intro-seen')).not.toBeNull();
    expect(localStorage.getItem('sp-appearance')).toBeNull();
  });

  it('not again once seen, not when the account holds a Design, not signed out, not under opt-in, not on the print route', async () => {
    localStorage.setItem('sp-lg-intro-seen', '1');
    const a = render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalled());
    await act(async () => {});
    a.unmount();
    localStorage.clear();

    getMy.mockResolvedValueOnce({
      ok: true,
      userId: USER,
      row: { style: 'liquid-glass', theme: null, updated_at: STAMP },
    });
    const b = render(<App userId={USER} />);
    await waitFor(() => expect(radio('Liquid Glass')).toBeChecked());
    await act(async () => {});
    b.unmount();
    localStorage.clear();

    const c = render(<App />);
    await waitFor(() => expect(glassOn()).toBe(true));
    await act(async () => {});
    c.unmount();

    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    const d = render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalledTimes(3));
    await act(async () => {});
    d.unmount();

    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    nav.pathname = '/dashboard/orders/abc/print';
    render(<App userId={USER} />);
    await waitFor(() => expect(getMy).toHaveBeenCalledTimes(4));
    await act(async () => {});

    expect(introCalls()).toEqual([]);
  });
});

describe('the kill switch: off is inert', () => {
  it('removes both attributes, keeps every stored value, reads and writes nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=liquid-glass; path=/';
    html().setAttribute('data-appearance', 'liquid-glass');
    html().setAttribute('data-lg-material', 'reduced');
    render(<App userId={USER} />);
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(html().hasAttribute('data-lg-material')).toBe(false);
    await act(async () => {});
    expect(getMy).not.toHaveBeenCalled();
    expect(setMy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record()).toEqual({ v: 2, style: 'liquid-glass' });
    expect(document.cookie).toContain('sp_style=liquid-glass');
    expect(localStorage.getItem('sp-appearance-sync')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('glassApplied: the attribute as the provider wrote it, for the selectors (DECISIONS.md F6)', () => {
  function Probe() {
    return <p data-testid="glass-applied">{String(useAppearance()?.glassApplied)}</p>;
  }
  function Probed() {
    return (
      <ThemeProvider>
        <AppearanceProvider>
          <AppearancePanel />
          <Probe />
        </AppearanceProvider>
      </ThemeProvider>
    );
  }
  const applied = () => screen.getByTestId('glass-applied').textContent;

  it('false on the server, even where glass will show (the first client render matches it)', () => {
    expect(renderToString(<Probed />)).toContain('>false</p>');
  });

  it('true once mounted with glass on <html>, and it follows each Design choice', async () => {
    render(<Probed />);
    expect(glassOn()).toBe(true);
    expect(applied()).toBe('true');
    fireEvent.click(radio('Classic'));
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(applied()).toBe('false');
    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(glassOn()).toBe(true));
    expect(applied()).toBe('true');
  });

  it('false on the print route, where the Design is glass but <html> is not', () => {
    nav.pathname = '/dashboard/orders/abc/print';
    const { rerender } = render(<Probed />);
    expect(radio('Liquid Glass')).toBeChecked();
    expect(glassOn()).toBe(false);
    expect(applied()).toBe('false');
    nav.pathname = '/dashboard/orders/abc';
    rerender(<Probed />);
    expect(glassOn()).toBe(true);
    expect(applied()).toBe('true');
  });

  it('false during the crash fallback, true again when glass is turned back on', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    render(<Probed />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(glassOn()).toBe(false);
    expect(applied()).toBe('false');
    act(() => (toast.mock.calls[0]![1] as { action: { onClick: () => void } }).action.onClick());
    expect(glassOn()).toBe(true);
    expect(applied()).toBe('true');
  });

  it('false under off, whatever is stored or already on <html>', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    html().setAttribute('data-appearance', 'liquid-glass');
    render(<Probed />);
    await waitFor(() => expect(glassOn()).toBe(false));
    expect(applied()).toBe('false');
  });
});

describe('the one-time crash fallback', () => {
  it('shows classic once with a notice whose way out is Use classic design, and leaves the stored choice alone', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    render(<App />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0]![0]).toBe(
      'Liquid Glass hit a problem, so StockPilot opened in the classic look.',
    );
    const options = toast.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
      cancel: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe('Turn Liquid Glass back on');
    expect(options.cancel.label).toBe('Use classic design');
    expect(glassOn()).toBe(false);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('shown');
    expect(record()).toEqual({ v: 2, style: 'liquid-glass' });

    act(() => options.action.onClick());
    expect(glassOn()).toBe(true);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('also for a person who never chose, under default (glass was the default they saw)', async () => {
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    render(<App />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    act(() => (toast.mock.calls[0]![1] as { cancel: { onClick: () => void } }).cancel.onClick());
    await waitFor(() => expect(record()).toMatchObject({ style: 'classic' }));
  });

  it('in Settings: Classic is checked while held, and choosing Liquid Glass turns it back on', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    sessionStorage.setItem('sp-lg-fallback', 'shown');
    render(<App />);
    await waitFor(() => expect(radio('Classic')).toBeChecked());
    expect(glassOn()).toBe(false);
    fireEvent.click(radio('Liquid Glass'));
    await waitFor(() => expect(glassOn()).toBe(true));
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });
});

describe('an open dialog survives every switch', () => {
  it('keeps the same dialog node, its typed value and its focus across Design and Theme switches', async () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <AppearanceProvider>
          <AppearancePanel />
          <Dialog open>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Hide items</DialogTitle>
              <input aria-label="Reason" defaultValue="" />
            </DialogContent>
          </Dialog>
        </AppearanceProvider>
      </ThemeProvider>,
    );
    const choice = (name: string) => screen.getByRole('radio', { name, hidden: true });
    const dialog = await screen.findByRole('dialog');
    const reason = screen.getByRole('textbox', { name: 'Reason' }) as HTMLInputElement & {
      __lgProbe?: string;
    };
    reason.__lgProbe = 'token';
    fireEvent.change(reason, { target: { value: 'kept' } });
    reason.focus();
    await waitFor(() => expect(choice('Liquid Glass')).toBeChecked());

    for (const next of ['Classic', 'Light', 'Liquid Glass', 'Dark']) {
      fireEvent.click(choice(next));
      await waitFor(() => expect(choice(next)).toBeChecked());
      expect(screen.getByRole('dialog')).toBe(dialog);
      const now = screen.getByRole('textbox', { name: 'Reason' }) as typeof reason;
      expect(now).toBe(reason);
      expect(now.__lgProbe).toBe('token');
      expect(now).toHaveValue('kept');
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(glassOn()).toBe(true);
  });
});

/** A pageshow event; jsdom's PageTransitionEvent ignores `persisted` in its init. */
function pageShow(persisted: boolean): Event {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

describe('the marketing variant guard (R8, round 2 finding 2)', () => {
  const hidden = () => document.head.querySelector('style[data-lg-variant-guard]') !== null;
  const earlyHidden = () => document.head.querySelector(`style[${EARLY_HIDE_ATTRIBUTE}]`) !== null;
  const marker = () => {
    const el = document.createElement('div');
    el.setAttribute('data-lg-twin', '');
    return el;
  };

  afterEach(() => {
    document.body.querySelectorAll('[data-lg-twin]').forEach((el) => el.remove());
    document.head.querySelectorAll('style[data-lg-variant-guard]').forEach((el) => el.remove());
    vi.useRealTimers();
  });

  function guard(props: Partial<React.ComponentProps<typeof MarketingVariantGuard>> = {}) {
    const setOverride = vi.fn();
    const view = render(
      <MarketingVariantGuard
        rollout="default"
        hydrated
        shownStyle="liquid-glass"
        fallback={false}
        setOverride={setOverride}
        {...props}
      />,
    );
    return { setOverride, ...view };
  }

  it('a match does nothing', () => {
    nav.pathname = '/';
    document.body.appendChild(marker());
    const { setOverride } = guard();
    expect(refresh).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
    expect(setOverride).toHaveBeenLastCalledWith(null);
  });

  it('the classic twin on screen while the cookie selects glass: hides, refreshes, and shows the page when the glass twin arrives', async () => {
    nav.pathname = '/';
    const { setOverride } = guard();
    expect(hidden()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      document.body.appendChild(marker());
    });
    await waitFor(() => expect(hidden()).toBe(false));
    expect(setOverride).toHaveBeenLastCalledWith(null);
  });

  it('the glass twin on screen after Classic was chosen elsewhere (Back within 180 s): refreshes', () => {
    nav.pathname = '/support';
    document.cookie = 'sp_style=classic; path=/';
    document.body.appendChild(marker());
    guard({ shownStyle: 'classic' });
    expect(hidden()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('no answer within 2 s: shows the page, the attribute following the twin on screen', () => {
    vi.useFakeTimers();
    nav.pathname = '/pricing';
    const { setOverride } = guard();
    expect(hidden()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(VARIANT_GUARD_TIMEOUT_MS);
    });
    expect(hidden()).toBe(false);
    expect(setOverride).toHaveBeenLastCalledWith(false);
  });

  it('crash fallback on a marketing page: the twin on screen decides, no refresh', () => {
    nav.pathname = '/';
    document.body.appendChild(marker());
    const { setOverride } = guard({ fallback: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(setOverride).toHaveBeenLastCalledWith(true);
  });

  it('a marketing page restored from the back/forward cache checks again: Classic chosen while it was frozen refreshes it', () => {
    nav.pathname = '/';
    document.body.appendChild(marker());
    guard();
    expect(refresh).not.toHaveBeenCalled();
    // Frozen in the cache while /signin (a whole-document load) chose Classic.
    document.cookie = 'sp_style=classic; path=/';
    act(() => {
      window.dispatchEvent(pageShow(true));
    });
    expect(hidden()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a restored landing whose Design changed while frozen never shows its twin on the other design: the attribute follows the twin on screen until the guard has the right one', async () => {
    nav.pathname = '/';
    document.body.appendChild(marker());
    render(<App />);
    expect(glassOn()).toBe(true);
    // Frozen while /signin chose Classic.
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    act(() => {
      window.dispatchEvent(pageShow(true));
    });
    // The glass twin is still on screen: the attribute stays with it, the page is hidden and asked for again.
    expect(glassOn()).toBe(true);
    expect(hidden()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The classic page arrives: shown, in classic.
    act(() => {
      document.querySelectorAll('[data-lg-twin]').forEach((el) => el.remove());
    });
    await waitFor(() => expect(hidden()).toBe(false));
    expect(glassOn()).toBe(false);
    expect(mounts).toBe(1);
  });

  it('a twin read again from the HTTP cache under Classic: the layout’s early hide holds until the guard has the classic page, then both hides go', async () => {
    nav.pathname = '/';
    document.cookie = 'sp_style=classic; path=/';
    // What the server's twin HTML did before it painted (twin-first-paint.ts).
    new Function(twinFirstPaintScript('default')!)();
    document.body.appendChild(marker());
    expect(earlyHidden()).toBe(true);
    const { setOverride } = guard({ shownStyle: 'classic' });
    expect(hidden()).toBe(true);
    expect(earlyHidden()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      document.querySelectorAll('[data-lg-twin]').forEach((el) => el.remove());
    });
    await waitFor(() => expect(hidden()).toBe(false));
    expect(earlyHidden()).toBe(false);
    expect(setOverride).toHaveBeenLastCalledWith(null);
  });

  it('an early hide with nothing left to decide (the cookie selects the twin on screen) goes at once', () => {
    nav.pathname = '/';
    document.cookie = 'sp_style=classic; path=/';
    new Function(twinFirstPaintScript('default')!)();
    document.cookie = 'sp_style=liquid-glass; path=/';
    document.body.appendChild(marker());
    guard();
    expect(refresh).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
  });

  it('no answer within 2 s: the early hide goes with the guard’s own', () => {
    nav.pathname = '/';
    document.cookie = 'sp_style=classic; path=/';
    // Its own 2 s timer runs on the real clock, so only the guard can remove it here.
    new Function(twinFirstPaintScript('default')!)();
    vi.useFakeTimers();
    document.body.appendChild(marker());
    const { setOverride } = guard({ shownStyle: 'classic' });
    expect(hidden()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(VARIANT_GUARD_TIMEOUT_MS);
    });
    expect(hidden()).toBe(false);
    expect(setOverride).toHaveBeenLastCalledWith(true);
  });

  it('an ordinary page load (not from the cache) does not check again', () => {
    nav.pathname = '/';
    document.body.appendChild(marker());
    guard();
    document.cookie = 'sp_style=classic; path=/';
    act(() => {
      window.dispatchEvent(pageShow(false));
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the provider re-reads the device record on a restore from the cache, so <html> follows a choice made while frozen', () => {
    nav.pathname = '/dashboard';
    render(<App />);
    expect(glassOn()).toBe(true);
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    act(() => {
      window.dispatchEvent(pageShow(true));
    });
    expect(glassOn()).toBe(false);
    expect(mounts).toBe(1);
  });

  it('off the 7 marketing paths it clears any override and does nothing else', () => {
    nav.pathname = '/signin';
    const { setOverride } = guard();
    expect(refresh).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
    expect(setOverride).toHaveBeenLastCalledWith(null);
  });
});
