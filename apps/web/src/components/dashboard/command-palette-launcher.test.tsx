import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandPaletteProps } from './command-palette';
import { CommandPaletteLauncher } from './command-palette-launcher';

/**
 * 2026-09-22 (cold start): the command palette (cmdk, its dialog, result rows)
 * no longer ships in the bundle every dashboard page hydrates with. The
 * launcher keeps the ⌘K listener and loads the palette on the first press or
 * at idle. These tests pin the one thing that split could break: the FIRST
 * press, made before the palette's code exists in the tab, must still open it.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

type PaletteComponent = React.ComponentType<CommandPaletteProps>;

function StubPalette({ open }: CommandPaletteProps) {
  return <div data-testid="palette" data-open={String(open)} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The exact event the topbar's search button synthesizes (topbar.tsx). */
function pressCmdK(init: KeyboardEventInit = { metaKey: true }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

// Idle is under the test's control: callbacks are captured, never run on
// their own, so "before idle" is a state a test can sit in.
let idleCallbacks: Array<() => void> = [];
const IDLE_APIS = ['requestIdleCallback', 'cancelIdleCallback'] as const;
const originalIdle = new Map<string, PropertyDescriptor | undefined>();

function setWindowProp(name: string, value: unknown) {
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  idleCallbacks = [];
  for (const name of IDLE_APIS) {
    originalIdle.set(name, Object.getOwnPropertyDescriptor(window, name));
  }
  setWindowProp('requestIdleCallback', (cb: () => void) => {
    idleCallbacks.push(cb);
    return idleCallbacks.length;
  });
  setWindowProp('cancelIdleCallback', () => undefined);
});

afterEach(() => {
  // Unmount first: the launcher's cleanup cancels its idle callback, and the
  // shared setup's cleanup() would otherwise run after the stubs are gone.
  cleanup();
  for (const name of IDLE_APIS) {
    const original = originalIdle.get(name);
    if (original) Object.defineProperty(window, name, original);
    else Reflect.deleteProperty(window, name);
  }
});

describe('CommandPaletteLauncher', () => {
  it('opens the real palette on the first ⌘K press, made before its code was loaded', async () => {
    render(<CommandPaletteLauncher />);
    expect(screen.queryByPlaceholderText(/Search items, POs, suppliers/)).not.toBeInTheDocument();

    const ev = pressCmdK();
    expect(ev.defaultPrevented).toBe(true);

    expect(
      await screen.findByPlaceholderText(/Search items, POs, suppliers/, undefined, {
        timeout: 10_000,
      }),
    ).toBeInTheDocument();
  });

  it('queues the open while the code is in flight and mounts the palette already open', async () => {
    const pending = deferred<PaletteComponent>();
    const load = vi.fn(() => pending.promise);
    render(<CommandPaletteLauncher load={load} />);
    expect(load).not.toHaveBeenCalled();

    pressCmdK();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('palette')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(StubPalette);
    });
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true');
  });

  it('prefetches at idle without opening, and a later press opens it with no second load', async () => {
    const load = vi.fn(async () => StubPalette as PaletteComponent);
    render(<CommandPaletteLauncher load={load} />);
    expect(load).not.toHaveBeenCalled();

    await act(async () => {
      idleCallbacks.forEach((cb) => cb());
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');

    pressCmdK({ ctrlKey: true });
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true');
    pressCmdK();
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never hijacks ⌘K from a text field, but ⌘K in the palette input closes it', async () => {
    const load = vi.fn(async () => StubPalette as PaletteComponent);
    render(
      <>
        <input data-testid="form-field" />
        <input data-testid="palette-input" data-cmdk="true" />
        <CommandPaletteLauncher load={load} />
      </>,
    );
    (screen.getByTestId('form-field') as HTMLInputElement).focus();
    const ev = pressCmdK();
    expect(ev.defaultPrevented).toBe(false);
    expect(load).not.toHaveBeenCalled();

    (screen.getByTestId('form-field') as HTMLInputElement).blur();
    pressCmdK();
    await waitFor(() => expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true'));

    (screen.getByTestId('palette-input') as HTMLInputElement).focus();
    pressCmdK();
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');
  });

  it('a failed load never reaches the page; the next press loads again and opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      override componentDidCatch(err: unknown) {
        errors.push(err);
      }
      override render() {
        return this.state.failed ? <p>page replaced</p> : this.props.children;
      }
    }
    const load = vi
      .fn<() => Promise<PaletteComponent>>()
      .mockRejectedValueOnce(new Error('ChunkLoadError'))
      .mockResolvedValueOnce(StubPalette);
    render(
      <Boundary>
        <p>the page</p>
        <CommandPaletteLauncher load={load} />
      </Boundary>,
    );

    pressCmdK();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByText('the page')).toBeInTheDocument();
    expect(errors).toEqual([]);

    // One press after a failure opens it: the failure closed the queued open,
    // so this press is not spent toggling it shut.
    pressCmdK();
    await waitFor(() => expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('the palette stays out of the dashboard first bundle', () => {
  const read = (file: string) =>
    readFileSync(path.resolve(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('the shell mounts the launcher and never imports the palette module statically', () => {
    const shell = read('dashboard-shell.tsx');
    expect(shell).toContain('<CommandPaletteLauncher />');
    expect(shell).not.toMatch(/from ['"]@\/components\/dashboard\/command-palette['"]/);
    expect(shell).not.toMatch(/from ['"]\.\/command-palette['"]/);
  });

  it('the launcher reaches the palette only through import() and a type-only import', () => {
    const launcher = read('command-palette-launcher.tsx');
    const staticImports = launcher.match(/^import .*command-palette['"];?$/gm) ?? [];
    expect(staticImports).toEqual([
      "import type { CommandPaletteProps } from '@/components/dashboard/command-palette';",
    ]);
    expect(launcher).toContain("import('@/components/dashboard/command-palette')");
  });
});
