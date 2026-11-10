import { PassThrough } from 'node:stream';

import { act, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToPipeableStream } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A page that is still streaming keeps the server's HTML (L4 triage BF1).
 *
 * The app's shape: the appearance provider sits in the root layout, above
 * every page, and a slow page streams the content of a Suspense boundary
 * after the shell. React adopts ("hydrates") that late content when it
 * arrives, unless something ABOVE the boundary changed a context value while
 * it was still on the way: context propagation marks every boundary that is
 * not adopted yet (react-dom-client, propagateContextChanges, `18 ===
 * fiber.tag`), the boundary gets one try at a raised priority, cannot be
 * adopted because its content is not there, and is then rendered in the
 * browser (updateDehydratedSuspenseComponent ->
 * retrySuspenseComponentWithoutHydrating). The server's nodes for it are
 * thrown away: content is built twice, live regions are announced twice,
 * effects run for a fresh mount, anything typed early is lost.
 *
 * So nothing the appearance layer learns while a page loads (the device
 * records at mount, the shell naming the person, the account answering, the
 * Theme becoming known) may change a context value above the page. This test
 * streams a real server render into the document, hydrates it while the
 * boundary is pending, lets every load-time update of the real provider
 * happen, then lets the stream finish, and checks that the late content on
 * screen IS the server's nodes.
 *
 * `off` is the control: the provider is inert there, so the same harness
 * adopts the nodes with or without the fix.
 *
 * TWO THINGS THIS TEST FOUND ON THE WAY (both React's and next-themes' own
 * behaviour, neither changed here):
 *  - Before the fix, a reader of the appearance placed right next to the
 *    boundary spared it: the boundary is rebuilt only when an ancestor of it
 *    that has no other work does the propagation. In the app the readers sit
 *    in the header and the streamed content deep in the page, so the pages
 *    here put the selector in a header, as the dashboard shell does.
 *  - next-themes changes ITS context value at mount when the stored Theme is
 *    an explicit Light or Dark that is not the system's (it first takes the
 *    stored Theme for the system's, then corrects it). That rebuilds a
 *    streaming page in the same way, with the flag off and on origin/main
 *    too. It is not the appearance layer's and is left as it is; the pages
 *    here use the system Theme, or an explicit one equal to the system's.
 */

const { getMy, setMy, toast, nav } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  toast: vi.fn(),
  nav: { pathname: '/dashboard/reports' },
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

import { AppearancePanel } from '@/components/settings/appearance-panel';

import { AppearanceAccountSync, AppearanceProvider, useAppearance } from './appearance-provider';
import { ThemeProvider } from './theme-provider';

const USER = '11111111-1111-4111-8111-111111111111';
const STAMP = '2026-11-02T10:00:00.000001+00:00';

/** What the late content waits for: the server's data, then (in the browser) the same data. */
interface Gate {
  done: boolean;
  promise: Promise<void>;
  open: () => void;
}
function gate(): Gate {
  let release = () => {};
  const g: Gate = {
    done: false,
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    open: () => {
      g.done = true;
      release();
    },
  };
  return g;
}

let lateMounts = 0;
function LateContent({ data }: { data: Gate }) {
  React.useEffect(() => {
    lateMounts += 1;
  }, []);
  // Suspends until its data is there, like a page that awaits a slow read.
  if (!data.done) throw data.promise;
  return (
    <section data-late="">
      <p aria-live="polite">12 orders</p>
      <input aria-label="Filter" defaultValue="" />
    </section>
  );
}

/** A reader of the appearance, as small as one can be. */
function Reader() {
  const appearance = useAppearance();
  return <i data-reader="" data-hydrated={String(appearance?.hydrated)} />;
}

/** A part of the page that reads nothing of the appearance. */
function Sidebar() {
  return <nav>Items</nav>;
}

/** How often each part rendered in the browser (React's count of commits it took part in). */
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

interface PageOptions {
  /** The dashboard shell names the person (dashboard-shell.tsx). */
  userId?: string;
  /** A real selector in the page header, outside the streamed part, as in the shell. */
  withSelector?: boolean;
  /** A reader right next to the streamed boundary. */
  withReader?: boolean;
  /** Something the person does while the page is still streaming. */
  whilePending?: (container: HTMLElement) => void;
}

function App({
  data,
  userId,
  withSelector,
  withReader,
}: Omit<PageOptions, 'whilePending'> & { data: Gate }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        {userId ? <AppearanceAccountSync userId={userId} /> : null}
        <div>
          <header>{withSelector ? <AppearancePanel /> : null}</header>
          <Counted id="sidebar">
            <Sidebar />
          </Counted>
          <main>
            <h1>Order totals</h1>
            {withReader ? (
              <Counted id="reader">
                <Reader />
              </Counted>
            ) : null}
            <React.Suspense fallback={<p data-loading="">Loading</p>}>
              <LateContent data={data} />
            </React.Suspense>
          </main>
        </div>
      </AppearanceProvider>
    </ThemeProvider>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The document is still being received. React reads this: a pending boundary
 * in a document that has finished loading is one the server gave up on, and
 * is rendered in the browser at once. The test DOM's document is always
 * complete, so the test says what a browser says while a page streams.
 */
let documentState: DocumentReadyState = 'complete';

/**
 * Put a piece of the server's stream into the document the way a browser's
 * parser does: the nodes are appended and each inline script runs, in order.
 * (innerHTML never runs scripts, so they are run here.) Returns the piece's
 * nodes, taken before any script could move them.
 */
function receive(html: string, into: HTMLElement): HTMLElement[] {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const scripts = Array.from(holder.querySelectorAll('script')).map((s) => s.textContent ?? '');
  const elements = Array.from(holder.querySelectorAll<HTMLElement>('*'));
  while (holder.firstChild) into.appendChild(holder.firstChild);
  for (const text of scripts) {
    // Indirect eval: global scope, like an inline script.
    (0, eval)(text);
  }
  return elements;
}

interface Streamed {
  container: HTMLElement;
  root: Root;
  recoverable: unknown[];
  /** The server's late nodes, as they arrived (before React's script moved them). */
  serverSection: HTMLElement;
  serverInput: HTMLInputElement;
}

/**
 * Stream the page, hydrate while the boundary is pending, let the provider's
 * load-time updates happen, then finish the stream.
 */
async function loadSlowPage(options: PageOptions): Promise<Streamed> {
  const page = {
    userId: options.userId,
    withSelector: options.withSelector,
    withReader: options.withReader,
  };
  // The server first, to its end: the shell goes out with the boundary
  // pending, then the page's data arrives and the rest follows. The two pieces
  // are then given to the browser in that order, with the hydration between.
  const serverData = gate();
  const clientData = gate();
  const chunks: string[] = [];
  const sink = new PassThrough();
  sink.setEncoding('utf8');
  sink.on('data', (chunk: string) => chunks.push(chunk));
  const ended = new Promise<void>((resolve) => sink.on('end', () => resolve()));

  await new Promise<void>((resolve, reject) => {
    const stream = renderToPipeableStream(<App data={serverData} {...page} />, {
      onShellReady: () => {
        stream.pipe(sink);
        resolve();
      },
      onShellError: reject,
      onError: reject,
    });
  });
  await sleep(0);
  const shell = chunks.splice(0).join('');
  // The boundary is in the shell as pending, with its fallback.
  expect(shell).toContain('<!--$?-->');
  expect(shell).toContain('Loading');
  expect(shell).not.toContain('12 orders');
  serverData.open();
  await ended;
  const rest = chunks.splice(0).join('');
  expect(rest).toContain('12 orders');
  // One process plays both sides here. React's server renderer leaves the
  // context values of its last task in place when it stops (it restores them
  // only when it was entered from another server render), and the browser
  // side would then start with the server's providers as its defaults
  // (next-themes would take itself for nested and the ids would differ). An
  // empty render by the same server renderer switches every context back to
  // its default.
  await new Promise<void>((resolve, reject) => {
    renderToPipeableStream(null, { onAllReady: () => resolve(), onError: reject });
  });

  documentState = 'loading';
  const container = document.createElement('div');
  document.body.appendChild(container);
  receive(shell, container);

  const recoverable: unknown[] = [];
  let root!: Root;
  lateMounts = 0;
  renders = {};
  // Hydrate with the boundary pending. Every effect of the provider and of
  // the shell runs here, and the account read answers.
  await act(async () => {
    root = hydrateRoot(container, <App data={clientData} {...page} />, {
      onRecoverableError: (error) => recoverable.push(error),
    });
  });
  await act(async () => {
    await sleep(0);
  });
  if (options.whilePending) {
    const { whilePending } = options;
    await act(async () => {
      whilePending(container);
      await sleep(0);
    });
  }
  // Whatever happened so far, the page's own data is not there yet.
  expect(container.querySelector('[data-late]')).toBeNull();
  expect(container.querySelector('[data-loading]')).not.toBeNull();

  // The rest of the stream arrives: the late content and React's script that
  // moves it into the boundary. The page's data reaches the browser with it.
  let arrived: HTMLElement[] = [];
  await act(async () => {
    arrived = receive(rest, document.body);
    clientData.open();
  });
  // React's script reveals a finished boundary a little later (it batches
  // reveals, up to 300 ms after the first paint) and asks React to adopt it
  // on the frame after that.
  for (let waited = 0; waited < 3000 && !container.querySelector('[data-late]'); waited += 20) {
    await act(async () => {
      await sleep(20);
    });
  }
  documentState = 'complete';
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await sleep(20);
    });
  }
  const serverSection = arrived.find((el) => el.hasAttribute('data-late'))!;
  const serverInput = arrived.find((el) => el.tagName === 'INPUT') as HTMLInputElement;
  expect(serverSection).toBeDefined();
  expect(serverInput).toBeDefined();
  return { container, root, recoverable, serverSection, serverInput };
}

function expectAdopted(page: Streamed): void {
  const onScreen = page.container.querySelector<HTMLElement>('[data-late]');
  expect(onScreen).not.toBeNull();
  // The fallback is gone and the late content is shown once.
  expect(page.container.querySelector('[data-loading]')).toBeNull();
  expect(page.container.querySelectorAll('[data-late]')).toHaveLength(1);
  // The content on screen is the server's own nodes, not a second build.
  expect(onScreen).toBe(page.serverSection);
  expect(page.container.querySelector('input[aria-label="Filter"]')).toBe(page.serverInput);
  // Hydrated (its effects ran), once.
  expect(lateMounts).toBe(1);
  expect(page.recoverable).toEqual([]);
  // And the server HTML matched what the browser rendered first.
  expect(complaints).toEqual([]);
}

const pages: Streamed[] = [];
async function load(options: PageOptions): Promise<Streamed> {
  const page = await loadSlowPage(options);
  pages.push(page);
  return page;
}

/** React's complaints (a hydration mismatch above all); none is expected. */
let complaints: string[] = [];

beforeEach(() => {
  complaints = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ');
    // Both of React's renderers live in this one process: a development-only
    // remark about that, which no browser and no server can make.
    if (text.includes('Detected multiple renderers concurrently rendering')) return;
    complaints.push(text);
  });
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => documentState,
  });
  lateMounts = 0;
  renders = {};
  getMy.mockReset();
  setMy.mockReset();
  toast.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  getMy.mockResolvedValue({ ok: true, userId: USER, row: null });
  setMy.mockImplementation(async ({ userId }: { userId: string }) => ({
    ok: true,
    userId,
    row: { style: null, theme: null, updated_at: STAMP },
  }));
});

afterEach(async () => {
  for (const page of pages.splice(0)) {
    await act(async () => page.root.unmount());
    page.container.remove();
  }
  document.body.innerHTML = '';
  documentState = 'complete';
  delete (document as unknown as Record<string, unknown>).readyState;
  vi.restoreAllMocks();
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

describe('control: with the flag off the provider is inert and the late content is adopted', () => {
  it('off: the server nodes of a streamed boundary stay', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    expectAdopted(await load({ userId: USER, withSelector: true }));
    expect(getMy).not.toHaveBeenCalled();
  });
});

describe('default rollout: a page that is still streaming keeps the server HTML', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  });

  it('Classic, signed out: reading the device records at mount does not rebuild the page', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const page = await load({});
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expectAdopted(page);
  });

  it('Classic, signed in: the shell naming the person and the account answering do not rebuild the page', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    getMy.mockResolvedValue({
      ok: true,
      userId: USER,
      row: { style: 'classic', theme: null, updated_at: STAMP },
    });
    const page = await load({ userId: USER });
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expectAdopted(page);
  });

  it('Liquid Glass (the default), signed in: the same', async () => {
    const page = await load({ userId: USER });
    expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
    expectAdopted(page);
  });

  it('with a selector on the page: the selector learns the choice, the streamed content is untouched', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    // An explicit Theme that is also the system's (see the note on next-themes below).
    localStorage.setItem('theme', 'light');
    const page = await load({ userId: USER, withSelector: true });
    expectAdopted(page);
    // The real reader did get every load-time fact.
    const checked = Array.from(
      page.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    )
      .filter((input) => input.checked)
      .map((input) => input.value);
    expect(checked).toEqual(['classic', 'light']);
    // The account answered (nothing to save): the signed-out line is gone.
    expect(getMy).toHaveBeenCalledWith(USER);
    expect(page.container.querySelector('[aria-live="polite"]:not(p)')?.textContent).toBe('');
  });

  it('a Design chosen while the page is still streaming: the choice applies, the streamed content is untouched', async () => {
    const page = await load({
      userId: USER,
      withSelector: true,
      whilePending: (container) => {
        expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
        fireEvent.click(container.querySelector('input[type="radio"][value="classic"]')!);
      },
    });
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expect(JSON.parse(localStorage.getItem('sp-appearance') ?? 'null')).toMatchObject({
      style: 'classic',
    });
    expect(setMy).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, style: 'classic' }));
    expectAdopted(page);
  });

  it('a reader next to the streamed content renders again for each fact; the rest of the page does not', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const page = await load({ userId: USER, withReader: true });
    expectAdopted(page);
    expect(page.container.querySelector('[data-reader]')?.getAttribute('data-hydrated')).toBe(
      'true',
    );
    // Hydration, then the facts as they came in.
    expect(renders.reader).toBeGreaterThan(1);
    // Rendered once, to adopt its server HTML, and never again.
    expect(renders.sidebar).toBe(1);
  });

  it('opt-in rollout, a stored Liquid Glass choice: the same', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=liquid-glass; path=/';
    const page = await load({ userId: USER });
    expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
    expectAdopted(page);
  });
});
