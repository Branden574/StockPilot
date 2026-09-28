// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MaintenancePhotosPanel takes its endpoints as props (F1-4). The exception
 * photo panel is one caller; these pin that the MAINTENANCE defaults are the
 * requests the panel always sent, including the browser-made thumbnail that
 * only maintenance takes, and that a panel given other endpoints never
 * touches the maintenance routes. maintenance-photos-panel.test.tsx pins the
 * rest of the maintenance behaviour, unchanged.
 */

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: file,
    thumbBlob: new Blob(['thumb'], { type: 'image/webp' }),
    lqip: null,
  })),
}));

import { MaintenancePhotosPanel, type PhotoPanelEndpoints } from './maintenance-photos-panel';

function jpeg(name = 'leak.jpg'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/jpeg' });
}
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn(async (url: string) => {
    if (url.endsWith('/attachments/finalize')) return { ok: true, json: async () => ({ id: 'a1' }) } as Response;
    if (url.endsWith('/attachments')) {
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
});
afterEach(() => vi.unstubAllGlobals());

describe('MaintenancePhotosPanel endpoints', () => {
  it('the maintenance default still PUTs the browser thumbnail to the thumb URL it minted', async () => {
    const onChange = vi.fn();
    render(<MaintenancePhotosPanel requestId="r1" photos={[]} onChange={onChange} />);
    await userEvent.upload(fileInput(), jpeg());
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      '/api/v1/maintenance-requests/r1/attachments',
      'https://storage.example.test/master',
      'https://storage.example.test/thumb',
      '/api/v1/maintenance-requests/r1/attachments/finalize',
    ]);
    const thumbPut = fetchSpy.mock.calls[2]!;
    expect(thumbPut[1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/webp' } });
  });

  it('the maintenance default removes at once (no dialog), and a failed DELETE says so', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const onChange = vi.fn();
    render(
      <MaintenancePhotosPanel
        requestId="r1"
        photos={[{ id: 'p1', originalFilename: 'leak.jpg', url: 'https://files.example.test/leak.jpg', thumbUrl: null }]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove leak.jpg' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not remove the photo.'));
    expect(onChange).not.toHaveBeenCalled();
    // No note field on the maintenance panel.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('given other endpoints, the panel calls only those, with the typed note, and sends no thumbnail they did not mint', async () => {
    const endpoints: PhotoPanelEndpoints = {
      mint: vi.fn(async () => ({ path: 'p/1.jpg', signedUrl: 'https://storage.example.test/evidence' })),
      finalize: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const onChange = vi.fn();
    render(
      <MaintenancePhotosPanel
        endpoints={endpoints}
        photos={[]}
        onChange={onChange}
        variant="card"
        noteField={{ label: 'Note', max: 500 }}
      />,
    );
    await userEvent.type(screen.getByLabelText('Note'), 'Bent shelf');
    await userEvent.upload(fileInput(), jpeg('shelf.jpg'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(endpoints.mint).toHaveBeenCalledWith({
      fileExt: 'jpg',
      originalFilename: 'shelf.jpg',
      declaredMime: 'image/jpeg',
      byteSize: 4,
    });
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['https://storage.example.test/evidence']);
    expect(endpoints.finalize).toHaveBeenCalledWith({
      path: 'p/1.jpg',
      originalFilename: 'shelf.jpg',
      declaredMime: 'image/jpeg',
      note: 'Bent shelf',
    });
  });

  it('a photo marked not removable has no Remove', () => {
    render(
      <MaintenancePhotosPanel
        requestId="r1"
        photos={[
          { id: 'p1', originalFilename: 'a.jpg', url: 'https://files.example.test/a.jpg', thumbUrl: null, canRemove: false },
          { id: 'p2', originalFilename: 'b.jpg', url: 'https://files.example.test/b.jpg', thumbUrl: null },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Remove a.jpg' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove b.jpg' })).toBeInTheDocument();
  });
});
