import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The item photo uploader's last word on a batch (lab walk 5, F4): a photo
// the server refused is never counted as uploaded.
//
// Lab walk 6, W6-F2: the summary toast was drawn on top of the refused
// photo's own sentence, which showed only when the toast stack was hovered
// or tapped. What became of each photo is now in the page, under the
// uploader, in a polite status region: every photo not added with its plain
// sentence, as visible text, with nothing positioned over it. The toast only
// counts, and points below. An all-added batch puts nothing in the page.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  refresh: vi.fn(),
  record: vi.fn(),
  presign: vi.fn(),
  put: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: new File([new Uint8Array([1, 2, 3])], `${file.name}.webp`, { type: 'image/webp' }),
    thumbBlob: null,
    lqip: null,
  })),
}));
vi.mock('@/lib/upload-with-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-with-progress')>()),
  uploadWithProgress: h.put,
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: h.presign,
  recordImageAction: h.record,
  removeImageAction: vi.fn(),
}));

import { ImageUploader } from './image-uploader';
import { handPhotoResultsTo } from './photo-results';

const REFUSED =
  'This file did not pass our checks, so it was not added. Try exporting or saving the file again, or send it another way.';

function photo(name: string, type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

async function upload(files: File[]) {
  const view = render(<ImageUploader itemId="item-1" initialImages={[]} />);
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: files } });
  await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  return view;
}

/** The uploader's status region: in the page, polite, under the drop zone. */
function region(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="photo-results"]');
  expect(el).not.toBeNull();
  expect(el!.getAttribute('role')).toBe('status');
  expect(el!.getAttribute('aria-live')).toBe('polite');
  return el!;
}

/** Every string any toast was given. */
function toastTexts(): string[] {
  return [h.toast.success, h.toast.error, h.toast.warning].flatMap((fn) =>
    fn.mock.calls.map((c) => String(c[0])),
  );
}

/** The sentence is text in the region a person sees, not a title, a tooltip or screen-reader-only text. */
function expectVisibleSentence(container: HTMLElement, sentence: string) {
  const el = within(region(container)).getByText(sentence);
  for (let node: HTMLElement | null = el; node && node !== container; node = node.parentElement) {
    expect(node.className).not.toMatch(/\bsr-only\b|\bhidden\b|\binvisible\b|\bopacity-0\b/);
    expect(node.hasAttribute('hidden')).toBe(false);
    expect(node.getAttribute('aria-hidden')).not.toBe('true');
  }
  // Its text, not an attribute: no title carries it.
  for (const titled of Array.from(container.querySelectorAll('[title]'))) {
    expect(titled.getAttribute('title')).not.toContain(sentence);
  }
}

beforeEach(() => {
  for (const fn of [h.toast.success, h.toast.error, h.toast.warning, h.refresh, h.record, h.presign, h.put]) {
    fn.mockReset();
  }
  h.presign.mockImplementation(async () => ({
    ok: true,
    data: { signedUrl: 'https://storage.example/up', thumbSignedUrl: 'https://storage.example/t', path: 'p', thumbPath: 't' },
  }));
  h.put.mockImplementation(async () => ({ ok: true }));
  h.record.mockImplementation(async () => ({ ok: true, data: { id: 'img' } }));
});

describe('the uploader counts what was added (lab walk 5, F4)', () => {
  it('every photo added: one success line with the count, and nothing put in the page', async () => {
    const { container } = await upload([photo('a.png'), photo('b.png')]);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledWith('2 photos added.');
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).not.toHaveBeenCalled();
    // The region is there for a screen reader, and empty: no layout jump.
    expect(region(container).textContent).toBe('');
    expect(region(container).childElementCount).toBe(0);
  });

  it('a refused photo is not counted as uploaded: its own sentence under the uploader, and a short toast', async () => {
    h.record.mockImplementation(async () =>
      h.record.mock.calls.length === 2
        ? { ok: false, error: { code: 'validation_error', message: REFUSED } }
        : { ok: true, data: { id: 'img' } },
    );
    const { container } = await upload([photo('a.png'), photo('b.png')]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith('1 photo added, 1 refused: see below.');
    expectVisibleSentence(container, REFUSED);
    expect(region(container).textContent).toContain('b.png');
    expect(region(container).textContent).toContain('1 photo added');
    // The sentence is in the page, never only in a toast.
    expect(toastTexts().join('\n')).not.toContain(REFUSED);
  });

  it('every photo refused: nothing said to be added, and the sentence in the page', async () => {
    h.record.mockImplementation(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    const { container } = await upload([photo('a.png')]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    expect(h.toast.error).toHaveBeenCalledWith('No photos added. 1 refused: see below.');
    expectVisibleSentence(container, REFUSED);
  });

  it('a photo that could not be sent is counted apart from a refused one, each with its sentence', async () => {
    h.put.mockImplementationOnce(async () => ({ ok: false }));
    h.record.mockImplementation(async () =>
      h.record.mock.calls.length === 1
        ? { ok: false, error: { code: 'validation_error', message: REFUSED } }
        : { ok: true, data: { id: 'img' } },
    );
    const { container } = await upload([photo('a.png'), photo('b.png'), photo('c.png')]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith('1 photo added, 1 refused, 1 not sent: see below.');
    expectVisibleSentence(container, REFUSED);
    expectVisibleSentence(container, 'Couldn\'t upload "a.png". Check your network and try again.');
  });

  it('a file the browser does not take is listed as not sent, never in a toast under the summary', async () => {
    const { container } = await upload([photo('a.gif', 'image/gif'), photo('b.png')]);
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith('1 photo added, 1 not sent: see below.');
    expectVisibleSentence(container, '"a.gif" isn\'t a supported image type. Use PNG, JPG, WEBP, or AVIF.');
  });
});

describe('nothing is drawn over the photo results (lab walk 6, W6-F2)', () => {
  it('the region sits in the page flow right under the drop zone; nothing in or around it is positioned', async () => {
    h.record.mockImplementation(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    const { container } = await upload([photo('a.png')]);
    const el = region(container);
    const root = container.firstElementChild as HTMLElement;
    // A direct child of the uploader, after the drop zone: below it in the flow.
    expect(el.parentElement).toBe(root);
    expect(el.previousElementSibling?.tagName).toBe('LABEL');
    const positioned = /(^|\s)(absolute|fixed|sticky|-?translate-[xy]?|-m[trblxy]?-|-?(top|bottom|inset)-|z-)/;
    for (const node of [root, el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      expect(String(node.getAttribute('class') ?? '')).not.toMatch(positioned);
      expect(node.getAttribute('style') ?? '').not.toMatch(/position|transform|margin-top:\s*-/);
    }
    // The uploader's own positioned pieces (the photo tiles' buttons) are
    // inside the photo grid, never around the region.
    for (const node of Array.from(root.querySelectorAll<HTMLElement>('.absolute'))) {
      expect(el.contains(node)).toBe(false);
      expect(node.contains(el)).toBe(false);
    }
  });

  it('a new pick clears the last results; an all-added pick leaves the region empty', async () => {
    h.record.mockImplementationOnce(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    const { container } = await upload([photo('a.png')]);
    expectVisibleSentence(container, REFUSED);
    h.refresh.mockReset();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo('b.png')] } });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(region(container).textContent).toBe('');
  });
});

describe('what the new-item form hands over (lab walk 6, W6-F2)', () => {
  it('is shown under the uploader when the item page opens, once', async () => {
    handPhotoResultsTo('item-1', [
      { name: 'shelf.png', outcome: 'refused', sentence: REFUSED },
      { name: 'front.png', outcome: 'added' },
    ]);
    const first = render(<ImageUploader itemId="item-1" initialImages={[]} />);
    expectVisibleSentence(first.container, REFUSED);
    expect(region(first.container).textContent).toContain('shelf.png');
    expect(h.toast.warning).not.toHaveBeenCalled();
    first.unmount();
    // Once: opening the page again shows nothing old.
    const again = render(<ImageUploader itemId="item-1" initialImages={[]} />);
    expect(region(again.container).textContent).toBe('');
  });

  it('is shown only for the item it was handed to', () => {
    handPhotoResultsTo('item-2', [{ name: 'shelf.png', outcome: 'refused', sentence: REFUSED }]);
    const { container } = render(<ImageUploader itemId="item-1" initialImages={[]} />);
    expect(region(container).textContent).toBe('');
  });
});
