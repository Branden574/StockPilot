import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

import { MaintenancePhotosPanel } from './maintenance-photos-panel';

const PHOTOS = [
  { id: 'p1', originalFilename: 'leak.jpg', url: 'https://files.example.test/leak.jpg', thumbUrl: null },
  { id: 'p2', originalFilename: 'panel.png', url: 'https://files.example.test/panel.png', thumbUrl: 'https://files.example.test/panel-thumb.webp' },
];

function makeFile(name: string, type = 'image/jpeg'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

beforeEach(() => toastErrorMock.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('MaintenancePhotosPanel (component test 5)', () => {
  it('previews every uploaded photo with a remove affordance and the count', () => {
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={vi.fn()} />);
    expect(screen.getByAltText('leak.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('panel.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove leak.jpg' })).toBeInTheDocument();
    expect(screen.getByText('Photos (2/8)')).toBeInTheDocument();
  });

  it('clicking a thumbnail opens the lightbox on the MASTER url, not the thumb', async () => {
    const user = userEvent.setup();
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={vi.fn()} />);
    // p2 has a distinct thumbUrl, so the pin proves master-vs-thumb selection.
    await user.click(screen.getByRole('button', { name: 'View panel.png' }));
    const dialog = await screen.findByRole('dialog');
    const imgs = Array.from(dialog.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    expect(imgs).toContain('https://files.example.test/panel.png');
    expect(imgs).not.toContain('https://files.example.test/panel-thumb.webp');
  });

  it('Escape closes the lightbox', async () => {
    const user = userEvent.setup();
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'View leak.jpg' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Remove stays Remove: clicking it never opens the lightbox', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove leak.jpg' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removing a photo calls the DELETE endpoint and notifies the parent to refetch', async () => {
    const onChange = vi.fn();
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove leak.jpg' }));
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/maintenance-requests/r1/attachments/p1', { method: 'DELETE' });
    expect(onChange).toHaveBeenCalled();
  });

  // --- Additional coverage for the reviewer's binding constraints ---

  it('enforces the client-side photo cap before ever touching the network', async () => {
    const onChange = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const eightPhotos = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      originalFilename: `p${i}.jpg`,
      url: `https://files.example.test/p${i}.jpg`,
      thumbUrl: null,
    }));
    render(<MaintenancePhotosPanel requestId="r1" photos={eightPhotos} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile('new.jpg'));
    expect(toastErrorMock).toHaveBeenCalledWith('A request can carry at most 8 photos.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uploads a photo through mint, PUT, and finalize, then clears it and notifies the parent', async () => {
    const onChange = vi.fn();
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/attachments/finalize')) {
        return { ok: true, json: async () => ({ id: 'new1', width: 10, height: 10 }) } as Response;
      }
      if (url.includes('/attachments') && !url.startsWith('https://storage.example.test')) {
        return {
          ok: true,
          json: async () => ({
            path: 'org/r1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',
            signedUrl: 'https://storage.example.test/master',
            token: 't',
            thumbPath: 'org/r1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-thumb.webp',
            thumbSignedUrl: 'https://storage.example.test/thumb',
            thumbToken: 'tt',
          }),
        } as Response;
      }
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile('new.jpg'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Never sends a thumbPath in the finalize body — the finalize route
    // derives it server-side (Task 9 CRITICAL 1c) and rejects a client-
    // supplied one being anything other than dead weight.
    const finalizeCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/attachments/finalize'));
    expect(finalizeCall).toBeTruthy();
    const finalizeBody = JSON.parse((finalizeCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect('thumbPath' in finalizeBody).toBe(false);
  });

  // --- Migration 0317/spec §2.2 — the `kind` prop threaded into both bodies ---

  function stubMintAndFinalize() {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/attachments/finalize')) {
        return { ok: true, json: async () => ({ id: 'new1', width: 10, height: 10 }) } as Response;
      }
      if (url.includes('/attachments') && !url.startsWith('https://storage.example.test')) {
        return {
          ok: true,
          json: async () => ({
            path: 'org/r1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',
            signedUrl: 'https://storage.example.test/master',
            token: 't',
            thumbPath: 'org/r1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-thumb.webp',
            thumbSignedUrl: 'https://storage.example.test/thumb',
            thumbToken: 'tt',
          }),
        } as Response;
      }
      return { ok: true } as Response;
    });
  }

  it('default panel (no kind prop): sends kind: "requester" in BOTH the mint and finalize bodies', async () => {
    const onChange = vi.fn();
    const fetchSpy = stubMintAndFinalize();
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile('new.jpg'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const mintCall = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes('/attachments') && !String(c[0]).includes('/finalize'),
    );
    const finalizeCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/attachments/finalize'));
    const mintBody = JSON.parse((mintCall![1] as RequestInit).body as string) as Record<string, unknown>;
    const finalizeBody = JSON.parse((finalizeCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(mintBody.kind).toBe('requester');
    expect(finalizeBody.kind).toBe('requester');
  });

  it('kind="resolution": LITERAL PIN — sends kind: "resolution" in BOTH the mint and finalize bodies', async () => {
    const onChange = vi.fn();
    const fetchSpy = stubMintAndFinalize();
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={[]} onChange={onChange} kind="resolution" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile('proof.jpg'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const mintCall = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes('/attachments') && !String(c[0]).includes('/finalize'),
    );
    const finalizeCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/attachments/finalize'));
    const mintBody = JSON.parse((mintCall![1] as RequestInit).body as string) as Record<string, unknown>;
    const finalizeBody = JSON.parse((finalizeCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(mintBody.kind).toBe('resolution');
    expect(finalizeBody.kind).toBe('resolution');
  });

  it('maps a 409 mint response to a human wait-and-retry message, not a generic failure, and offers Retry', async () => {
    const onChange = vi.fn();
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('/attachments') && !url.startsWith('https://storage.example.test')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'conflict', message: 'Too many uploads in the last hour. Please try again later.' }),
        } as Response;
      }
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile('new.jpg'));
    expect(await screen.findByText('Too many uploads in the last hour. Please try again later.')).toBeInTheDocument();
    expect(screen.queryByText('Upload not allowed right now.')).toBeNull();
    const retryButton = screen.getByRole('button', { name: 'Retry new.jpg' });
    fetchSpy.mockClear();
    await userEvent.click(retryButton);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
