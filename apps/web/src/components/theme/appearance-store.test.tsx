import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The appearance facts live in a store, not in a context value (L4 triage
 * BF1; appearance-store.ts says why). This file checks the store by itself,
 * then the provider's use of it: the context hands the tree ONE object for
 * good, every fact the layer learns while a page loads reaches the readers
 * through the store, and a component that reads nothing renders once.
 * appearance-provider.streaming.test.tsx checks what this is all for.
 */

const { getMy, setMy, toast, nav } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  toast: vi.fn(),
  nav: { pathname: '/dashboard' },
}));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  AppearanceAccountSync,
  AppearanceProvider,
  initialAppearanceFacts,
  useAppearance,
  useAppearanceActions,
  type AppearanceActions,
  type AppearanceContextValue,
} from './appearance-provider';
import { createFactStore, NO_FACT_STORE, type AppearanceFacts } from './appearance-store';
import { ThemeProvider } from './theme-provider';

const USER = '11111111-1111-4111-8111-111111111111';
const STAMP = '2026-11-02T10:00:00.000001+00:00';

describe('the fact store', () => {
  const start = { hydrated: false, count: 0, name: null as string | null };

  it('its server snapshot is what it was created with, whatever it learns later', () => {
    const store = createFactStore(start);
    const server = store.getServerSnapshot();
    expect(server).toEqual(start);
    expect(store.getSnapshot()).toBe(server);
    store.set({ hydrated: true, count: 3 });
    expect(store.getSnapshot()).toEqual({ hydrated: true, count: 3, name: null });
    expect(store.getServerSnapshot()).toBe(server);
    expect(store.getServerSnapshot()).toEqual(start);
    // Neither the caller's object nor a snapshot can be changed behind it.
    expect(Object.isFrozen(server)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(server).not.toBe(start);
  });

  it('tells every subscriber once per change, and nobody after they stop', () => {
    const store = createFactStore(start);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = store.subscribe(first);
    store.subscribe(second);
    store.set({ hydrated: true, count: 1 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    store.set({ count: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('a value that did not change tells nobody and keeps the snapshot', () => {
    const store = createFactStore(start);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.set({ hydrated: false });
    store.set({ count: 0, name: null });
    store.set({});
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    store.set({ name: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    const after = store.getSnapshot();
    store.set({ name: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(after);
  });

  it('a subscriber may stop while it is being told', () => {
    const store = createFactStore(start);
    const other = vi.fn();
    const stop = store.subscribe(() => stop());
    store.subscribe(other);
    store.set({ count: 1 });
    store.set({ count: 2 });
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('with no provider there is nothing to read and nothing to wait for', () => {
    expect(NO_FACT_STORE.getSnapshot()).toBeNull();
    expect(NO_FACT_STORE.getServerSnapshot()).toBeNull();
    const stop = NO_FACT_STORE.subscribe();
    expect(() => stop()).not.toThrow();
  });
});

describe('the facts of the server render and of the first client render', () => {
  it('default: nothing of this device is known; the rollout decides the Design', () => {
    expect(initialAppearanceFacts('default')).toEqual({
      hydrated: false,
      style: null,
      theme: undefined,
      shownStyle: 'liquid-glass',
      glassApplied: false,
      status: null,
    });
  });

  it('opt-in: classic until this device says otherwise', () => {
    expect(initialAppearanceFacts('opt-in')).toEqual({
      hydrated: false,
      style: null,
      theme: undefined,
      shownStyle: 'classic',
      glassApplied: false,
      status: null,
    });
  });

  it('off: classic, for good', () => {
    expect(initialAppearanceFacts('off')).toEqual({
      hydrated: true,
      style: null,
      theme: undefined,
      shownStyle: 'classic',
      glassApplied: false,
      status: null,
    });
  });
});

/** The six facts a reader sees, one entry for each of its renders. */
let seen: AppearanceFacts[] = [];
let latest: AppearanceContextValue | null = null;
function Reader() {
  const appearance = useAppearance();
  // After every render of this component (no dependency list).
  React.useEffect(() => {
    latest = appearance;
    if (appearance) {
      const { hydrated, style, theme, shownStyle, glassApplied, status } = appearance;
      seen.push({ hydrated, style, theme, shownStyle, glassApplied, status });
    }
  });
  return <p data-testid="reader">{appearance ? appearance.shownStyle : 'none'}</p>;
}

/** What the context itself holds, one entry for each render of its reader. */
let handed: (AppearanceActions | null)[] = [];
function ActionsOnly() {
  const actions = useAppearanceActions();
  React.useEffect(() => {
    handed.push(actions);
  });
  return (
    <button type="button" onClick={() => actions?.chooseStyle('classic')}>
      Classic please
    </button>
  );
}

/** A part of the page that reads nothing of the appearance. */
function Bystander() {
  return <span>page</span>;
}

/** How often each part rendered (React's own count of commits it took part in). */
let renders: Record<string, number> = {};
function Counted({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <React.Profiler
      id={id}
      onRender={() => {
        renders[id] = (renders[id] ?? 0) + 1;
      }}
    >
      {children}
    </React.Profiler>
  );
}

function App({ userId }: { userId?: string }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        {userId ? <AppearanceAccountSync userId={userId} /> : null}
        <Counted id="reader">
          <Reader />
        </Counted>
        <ActionsOnly />
        <Counted id="bystander">
          <Bystander />
        </Counted>
      </AppearanceProvider>
    </ThemeProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  seen = [];
  handed = [];
  renders = {};
  latest = null;
  nav.pathname = '/dashboard';
  getMy.mockReset();
  setMy.mockReset();
  toast.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  getMy.mockResolvedValue({ ok: true, userId: USER, row: null });
  setMy.mockImplementation(
    async ({ userId, style, theme }: { userId: string; style?: string; theme?: string }) => ({
      ok: true,
      userId,
      row: { style: style ?? null, theme: theme ?? null, updated_at: STAMP },
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('data-lg-material');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});

describe('the provider hands the tree one context value, for good', () => {
  it('mount, the shell naming the person, the account answering and a choice: the same object, and its reader renders once', async () => {
    const answer = deferred<unknown>();
    getMy.mockReturnValue(answer.promise);
    const view = render(<App />);
    // Mounted: the device records were read and the attribute written.
    expect(latest?.hydrated).toBe(true);
    // The shell names the person.
    view.rerender(<App userId={USER} />);
    await act(async () => {});
    expect(getMy).toHaveBeenCalledWith(USER);
    // The account answers.
    await act(async () => {
      answer.resolve({ ok: true, userId: USER, row: null });
    });
    // A choice.
    fireEvent.click(screen.getByRole('button', { name: 'Classic please' }));
    await act(async () => {});
    expect(latest?.shownStyle).toBe('classic');
    expect(setMy).toHaveBeenCalled();

    // The context value: one object, never replaced. (The reader of the
    // actions rendered for the two renders of <App> and for nothing else.)
    expect(handed[0]).not.toBeNull();
    expect(new Set(handed).size).toBe(1);
    expect(handed).toHaveLength(2);
    // The part of the page that reads nothing: the same two renders.
    expect(renders.bystander).toBe(2);
    // The reader of the facts did render for them.
    expect(renders.reader).toBeGreaterThan(3);
  });

  it('the actions keep their identity through every fact', async () => {
    render(<App userId={USER} />);
    const first = latest!;
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Classic please' }));
    await act(async () => {});
    const last = latest!;
    expect(last).not.toBe(first);
    for (const name of [
      'chooseStyle',
      'chooseTheme',
      'keepGlass',
      'retry',
      'signedInUserId',
    ] as const) {
      expect(last[name], name).toBe(first[name]);
    }
    expect(last.rollout).toBe('default');
    expect(last.signedInUserId()).toBe(USER);
  });
});

describe('every fact learned while a page loads reaches the readers through the store', () => {
  it('the server render and the first client render: the pre-hydrate facts', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    localStorage.setItem('theme', 'dark');
    // The server knows nothing of this device: the rollout's default.
    expect(renderToString(<App userId={USER} />)).toContain(
      '<p data-testid="reader">liquid-glass</p>',
    );
    render(<App userId={USER} />);
    expect(seen[0]).toEqual(initialAppearanceFacts('default'));
    expect(seen.at(-1)?.shownStyle).toBe('classic');
  });

  it('mount: hydrated, the stored Design, the Theme and the attribute as written, in one render', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    localStorage.setItem('theme', 'dark');
    render(<App />);
    expect(seen).toEqual([
      initialAppearanceFacts('default'),
      {
        hydrated: true,
        style: 'classic',
        theme: 'dark',
        shownStyle: 'classic',
        glassApplied: false,
        status: 'signed-out',
      },
    ]);
  });

  it('mount in Liquid Glass (the default): glassApplied turns true with the attribute', () => {
    render(<App />);
    expect(seen).toEqual([
      initialAppearanceFacts('default'),
      {
        hydrated: true,
        style: null,
        theme: 'system',
        shownStyle: 'liquid-glass',
        glassApplied: true,
        status: 'signed-out',
      },
    ]);
    expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it('the shell naming the person, then the account answering: the status follows', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    const answer = deferred<unknown>();
    getMy.mockReturnValue(answer.promise);
    render(<App userId={USER} />);
    await act(async () => {});
    // Named, not answered yet: the Design is this device's own, to be saved.
    const named = seen.at(-1)!;
    expect(named.hydrated).toBe(true);
    expect(named.status).not.toBe('signed-out');
    const before = seen.length;
    await act(async () => {
      answer.resolve({
        ok: true,
        userId: USER,
        row: { style: 'liquid-glass', theme: 'dark', updated_at: STAMP },
      });
    });
    // The account's newer choice is adopted: Design, Theme and attribute.
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.at(-1)).toMatchObject({
      style: 'liquid-glass',
      shownStyle: 'liquid-glass',
      glassApplied: true,
      theme: 'dark',
    });
    expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it('the crash fallback: classic on screen while the stored choice stays Liquid Glass', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    sessionStorage.setItem('sp-lg-fallback', 'shown');
    render(<App />);
    expect(seen.at(-1)).toMatchObject({
      hydrated: true,
      style: 'liquid-glass',
      shownStyle: 'classic',
      glassApplied: false,
    });
  });

  it('a Theme chosen in another tab reaches the readers', async () => {
    render(<App />);
    expect(seen.at(-1)?.theme).toBe('system');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
    });
    expect(seen.at(-1)?.theme).toBe('dark');
  });

  it('off: the facts never change, nothing is read and nobody renders again', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    localStorage.setItem('theme', 'dark');
    render(<App userId={USER} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Classic please' }));
    await act(async () => {});
    expect(seen).toEqual([initialAppearanceFacts('off')]);
    expect(renders.reader).toBe(1);
    expect(renders.bystander).toBe(1);
    expect(handed).toHaveLength(1);
    expect(getMy).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
  });
});

describe('a reader with no provider above', () => {
  it('gets null, on the server and in the browser', () => {
    expect(renderToString(<Reader />)).toContain('>none</p>');
    render(<Reader />);
    expect(screen.getByTestId('reader').textContent).toBe('none');
    expect(latest).toBeNull();
  });
});
