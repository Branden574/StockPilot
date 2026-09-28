// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
  EXCEPTION_EVIDENCE_NONE_COPY,
  EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
  EXCEPTION_EVIDENCE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_REMOVE_COPY,
  EXCEPTION_EVIDENCE_REMOVE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
  EXCEPTION_EVIDENCE_UNCONFIRMED_COPY,
} from '@stockpilot/core';

/**
 * The photo panel on an exception (F1-4). What it must get right:
 *   - an upload is mint (the server action), one PUT of the photo to the
 *     signed URL and NO thumbnail (the server makes it from the cleaned
 *     photo), then finalize with the note and no capture time (a browser does
 *     not know when a photo was taken);
 *   - a file the bucket would refuse never reaches the server;
 *   - THE NOTE BELONGS TO ITS UPLOAD: a retry sends the note it was chosen
 *     with, whatever the field says since;
 *   - A LOST FINALIZE ANSWER IS NOT A SECOND PHOTO: Retry resends that
 *     finalize for the same upload, and "already recorded" is success; a
 *     finalize the server answered starts again from the mint;
 *   - Remove asks first, with an optional reason, and fails inline;
 *   - read-only, offline and at the cap, nothing is sent and the reason is
 *     shown; a failed read is never "No photos yet.".
 *
 * Review findings 2026-09-27: a refusal the server would repeat (resolved,
 * the cap, the file refused) offers Dismiss only and re-reads the exception;
 * every failed row can be dismissed; a lost answer reads "Not confirmed" (the
 * photo may be saved); a rate-limited finalize resends the same upload;
 * offline, Remove stays in place, disabled, with the reason, and its target
 * is at least 24px; a photo that fails to load (an expired link) says so
 * with Try again, never a blank tile.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));
const start = vi.fn();
const finalize = vi.fn();
const remove = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  startExceptionEvidenceUploadAction: (...a: unknown[]) => start(...a),
  finalizeExceptionEvidenceAction: (...a: unknown[]) => finalize(...a),
  removeExceptionEvidenceAction: (...a: unknown[]) => remove(...a),
}));
// The browser's resize is its own unit (image-variants tests). Here it hands
// the file back with a thumbnail, so a thumbnail PUT would be visible.
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: file,
    thumbBlob: new Blob(['thumb'], { type: 'image/webp' }),
    lqip: null,
  })),
}));

import { EVIDENCE_CONNECTION_COPY, OccurrencePhotos } from './occurrence-photos';

const OCC = '11111111-1111-4111-8111-111111111111';
const PATH = `org-1/${OCC}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
const SIGNED = 'https://storage.example.test/upload/sign/x?token=t';

function ticket(path = PATH) {
  return {
    ok: true,
    ticket: {
      path,
      signedUrl: SIGNED,
      token: 't',
      contentType: 'image/jpeg',
      maxBytes: EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
    },
  };
}
const RECORDED = {
  ok: true,
  evidence: {
    id: 'ph-new',
    contentType: 'image/jpeg',
    byteSize: 4,
    width: 1,
    height: 1,
    capturedAt: null,
    uploadedAt: '2026-09-27T17:40:00Z',
  },
};

function photo(o: Record<string, unknown> = {}) {
  return {
    id: 'ph-1',
    uploadedBy: { id: 'u1', label: 'Dana Lee' },
    capturedAt: null,
    uploadedAt: '2026-09-27T17:40:00Z',
    note: null,
    contentType: 'image/jpeg',
    byteSize: 1000,
    url: 'https://files.example.test/ph-1.jpg',
    thumbUrl: null,
    canRemove: true,
    ...o,
  };
}

function evidence(photos: ReturnType<typeof photo>[] = []) {
  return {
    status: 'ok' as const,
    photos,
    liveCount: photos.length,
    maxPhotos: 8,
    canAdd: photos.length < 8,
  };
}

type Props = Parameters<typeof OccurrencePhotos>[0];
function renderPanel(o: Partial<Props> = {}) {
  return render(
    <OccurrencePhotos
      occurrenceId={OCC}
      evidence={evidence()}
      resolved={false}
      canAct
      timeZone="America/Chicago"
      {...o}
    />,
  );
}

function jpeg(name = 'shelf.jpg', bytes = 4, type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

let fetchSpy: ReturnType<typeof vi.fn>;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

// happy-dom never loads an image and reports each one as complete with no
// width, which a browser reports only for a BROKEN image. Model a browser in
// which the photos are still loading; the one test about an image that had
// already failed when the page became interactive sets its own state.
const imageComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal('fetch', fetchSpy);
  setOnline(true);
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
  if (imageComplete) Object.defineProperty(HTMLImageElement.prototype, 'complete', imageComplete);
  else delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
});

describe('OccurrencePhotos: adding', () => {
  it('mints, PUTs only the photo, and finalizes with the note and no capture time, then refreshes', async () => {
    start.mockResolvedValue(ticket());
    finalize.mockResolvedValue(RECORDED);
    renderPanel();
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: '  Shelf empty  ' } });
    const file = jpeg();
    await userEvent.upload(fileInput(), file);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    expect(start).toHaveBeenCalledWith(OCC, { fileExt: 'jpg' });
    // One request to storage: the photo. Mutation caught: PUTting the
    // browser's thumbnail (the server makes its own from the cleaned photo).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(SIGNED, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: file,
    });
    expect(finalize).toHaveBeenCalledWith(OCC, {
      path: PATH,
      declaredMime: 'image/jpeg',
      capturedAt: null,
      note: 'Shelf empty',
    });
    // The note went with the photo; the field is ready for the next one.
    expect(screen.getByLabelText(/^Note/)).toHaveValue('');
  });

  it('a file the bucket would refuse (not JPEG, PNG or WEBP after conversion, or over 10 MB) is never sent', async () => {
    renderPanel();
    await userEvent.upload(fileInput(), jpeg('IMG_1.heic', 4, 'image/heic'));
    expect(await screen.findByText(EXCEPTION_EVIDENCE_REJECTED_COPY)).toBeInTheDocument();
    await userEvent.upload(fileInput(), jpeg('big.jpg', EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES + 1));
    await waitFor(() =>
      expect(screen.getAllByText(EXCEPTION_EVIDENCE_REJECTED_COPY)).toHaveLength(2),
    );
    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_image', EXCEPTION_EVIDENCE_REJECTED_COPY],
    ['occurrence_resolved', EXCEPTION_EVIDENCE_RESOLVED_COPY],
    ['evidence_limit_reached', EXCEPTION_EVIDENCE_CAP_COPY],
  ])(
    'a refusal the server would repeat (%s) shows its words with Dismiss only, and re-reads the exception',
    async (reason, message) => {
      start.mockResolvedValue(ticket());
      finalize.mockResolvedValueOnce({ error: { message, reason } });
      renderPanel();
      await userEvent.upload(fileInput(), jpeg());
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry shelf.jpg' })).not.toBeInTheDocument();
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss shelf.jpg' }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    },
  );

  it('the same refusal at the mint (resolved since the page loaded) is final too, and re-reads', async () => {
    start.mockResolvedValueOnce({
      error: { message: EXCEPTION_EVIDENCE_RESOLVED_COPY, reason: 'occurrence_resolved' },
    });
    renderPanel();
    await userEvent.upload(fileInput(), jpeg());
    expect(await screen.findByText(EXCEPTION_EVIDENCE_RESOLVED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry shelf.jpg' })).not.toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('a failure worth retrying shows its words with Retry and Dismiss, and Retry starts again from the mint', async () => {
    start.mockResolvedValue(ticket());
    finalize.mockResolvedValueOnce({
      error: {
        message: 'This exception is busy. Please add the photo again.',
        reason: 'busy',
        retryable: true,
      },
    });
    renderPanel();
    await userEvent.upload(fileInput(), jpeg());
    expect(
      await screen.findByText('This exception is busy. Please add the photo again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss shelf.jpg' })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();

    // The server deleted that upload when it refused it: a retry is a new one.
    start.mockResolvedValueOnce(ticket(PATH.replace('aaaaaaaa-aaaa', 'bbbbbbbb-bbbb')));
    finalize.mockResolvedValueOnce(RECORDED);
    await userEvent.click(screen.getByRole('button', { name: 'Retry shelf.jpg' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls[1]![1].path).toBe(PATH.replace('aaaaaaaa-aaaa', 'bbbbbbbb-bbbb'));
  });

  // Mutations caught: Retry after a lost answer uploading the photo again
  // (two photos), and "already recorded" shown as a failure.
  it('a finalize that never answered is resent for the same upload, and "already recorded" is success', async () => {
    start.mockResolvedValue(ticket());
    finalize.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPanel();
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Label says 99-Z' } });
    await userEvent.upload(fileInput(), jpeg());
    // The photo may be saved: never worded as a failed upload.
    expect(
      await screen.findByText(`Not confirmed. ${EXCEPTION_EVIDENCE_UNCONFIRMED_COPY}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(EVIDENCE_CONNECTION_COPY)).not.toBeInTheDocument();

    finalize.mockResolvedValueOnce({
      error: { message: 'This photo was already added.', reason: 'already_recorded' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry shelf.jpg' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls[1]).toEqual(finalize.mock.calls[0]);
    expect(finalize.mock.calls[1]![1]).toMatchObject({ path: PATH, note: 'Label says 99-Z' });
    expect(screen.queryByRole('button', { name: 'Retry shelf.jpg' })).not.toBeInTheDocument();
  });

  it('a finalize the limiter refused keeps its upload: Retry resends that finalize, never a second upload', async () => {
    start.mockResolvedValue(ticket());
    finalize.mockResolvedValueOnce({
      error: { message: EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY, reason: 'rate_limited' },
    });
    renderPanel();
    await userEvent.upload(fileInput(), jpeg());
    expect(await screen.findByText(EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY)).toBeInTheDocument();
    finalize.mockResolvedValueOnce(RECORDED);
    await userEvent.click(screen.getByRole('button', { name: 'Retry shelf.jpg' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[1]).toEqual(finalize.mock.calls[0]);
  });

  it('Dismiss clears a failed row; dismissing a not-confirmed one re-reads (it may be saved)', async () => {
    start.mockResolvedValueOnce({
      error: {
        message: 'Too many photo uploads in the last hour. Please try again later.',
        reason: 'rate_limited',
      },
    });
    renderPanel();
    await userEvent.upload(fileInput(), jpeg('a.jpg'));
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss a.jpg' }));
    expect(screen.queryByText(/a\.jpg/)).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();

    start.mockResolvedValueOnce(ticket());
    finalize.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await userEvent.upload(fileInput(), jpeg('b.jpg'));
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss b.jpg' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  // Mutation caught: the retry reading the note field instead of the note the
  // photo was chosen with.
  it('the note belongs to its upload: a retry sends it even after the field changed', async () => {
    start.mockResolvedValueOnce({
      error: {
        message: 'Too many photo uploads in the last hour. Please try again later.',
        reason: 'rate_limited',
      },
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'First note' } });
    await userEvent.upload(fileInput(), jpeg());
    expect(
      await screen.findByText('Too many photo uploads in the last hour. Please try again later.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/note: First note/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Something else' } });
    start.mockResolvedValueOnce(ticket());
    finalize.mockResolvedValueOnce(RECORDED);
    await userEvent.click(screen.getByRole('button', { name: 'Retry shelf.jpg' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(finalize.mock.calls[0]![1].note).toBe('First note');
  });

  it('a note over 500 characters turns Add photos off, and nothing is sent', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'x'.repeat(501) } });
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(screen.getByText('501 / 500')).toBeInTheDocument();
    await userEvent.upload(fileInput(), jpeg());
    expect(start).not.toHaveBeenCalled();
  });

  it('at the cap nothing is sent, and the cap is said', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => photo({ id: `ph-${i}` }));
    renderPanel({ evidence: evidence(eight) });
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(
      EXCEPTION_EVIDENCE_CAP_COPY,
    );
    await userEvent.upload(fileInput(), jpeg());
    expect(start).not.toHaveBeenCalled();
  });

  it('a selection that would pass the cap is refused whole, before the network', async () => {
    renderPanel({
      evidence: evidence(Array.from({ length: 7 }, (_, i) => photo({ id: `ph-${i}` }))),
    });
    await userEvent.upload(fileInput(), [jpeg('a.jpg'), jpeg('b.jpg')]);
    expect(toastError).toHaveBeenCalledWith(EXCEPTION_EVIDENCE_CAP_COPY);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('OccurrencePhotos: who sees what', () => {
  it('read-only: no Add photos, no note field, no file input, and a drop sends nothing', async () => {
    const { container } = renderPanel({
      canAct: false,
      evidence: evidence([photo({ canRemove: false })]),
    });
    expect(screen.queryByRole('button', { name: 'Add photos' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Note/)).not.toBeInTheDocument();
    expect(fileInput()).toBeNull();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(
      EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
    );
    const region = container.querySelector('section')!;
    await act(async () => {
      fireEvent.drop(region, { dataTransfer: { files: [jpeg()] } });
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('offline: Add photos is off with the reason, and Remove stays in place, disabled, saying why', () => {
    setOnline(false);
    renderPanel({ evidence: evidence([photo()]) });
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(
      EXCEPTION_EVIDENCE_OFFLINE_COPY,
    );
    const removeButton = screen.getByRole('button', { name: 'Remove Photo 1' });
    expect(removeButton).toBeDisabled();
    const reason = screen.getByTestId('photos-remove-unavailable');
    expect(reason).toHaveTextContent(EXCEPTION_EVIDENCE_REMOVE_OFFLINE_COPY);
    expect(removeButton.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('Remove is a target of at least 24px (WCAG 2.5.8)', () => {
    renderPanel({ evidence: evidence([photo()]) });
    expect(screen.getByRole('button', { name: 'Remove Photo 1' }).className).toMatch(/\bmin-h-6\b/);
  });

  it('a photo whose link has expired (or cannot load) says so with Try again, never a blank tile', async () => {
    renderPanel({ evidence: evidence([photo()]) });
    fireEvent.error(screen.getByRole('img', { name: 'Photo 1' }));
    expect(await screen.findByText(EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again: Photo 1' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Browser walk 2026-09-27: an image that failed while the page was still
  // loading (before React attached onError) stayed a broken tile. Mutation
  // caught: relying on the error event alone.
  it('a photo that had already failed to load when the page became interactive says so too', () => {
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    const naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 0 });
    try {
      renderPanel({ evidence: evidence([photo()]) });
      expect(screen.getByText(EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again: Photo 1' })).toBeInTheDocument();
    } finally {
      if (complete) Object.defineProperty(HTMLImageElement.prototype, 'complete', complete);
      else delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
      if (naturalWidth) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', naturalWidth);
      else delete (HTMLImageElement.prototype as { naturalWidth?: number }).naturalWidth;
    }
  });

  it('a photo still loading (or loaded) is not taken for a failed one', () => {
    renderPanel({ evidence: evidence([photo()]) });
    expect(screen.queryByText(EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Photo 1' })).toBeInTheDocument();
  });

  it('the full-size photo failing in the viewer says so with Try again, not an endless spinner', async () => {
    renderPanel({ evidence: evidence([photo()]) });
    await userEvent.click(screen.getByRole('button', { name: 'View Photo 1' }));
    const dialog = await screen.findByRole('dialog');
    const img = dialog.querySelector('img')!;
    fireEvent.error(img);
    expect(
      await within(dialog).findByText(EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('going offline while the page is open turns adding off at once', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeEnabled();
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(
      EXCEPTION_EVIDENCE_OFFLINE_COPY,
    );
  });

  it('each photo shows its note, who added it and its two clocks', () => {
    renderPanel({
      evidence: evidence([
        photo({
          note: 'Bottom row',
          capturedAt: '2026-09-27T15:02:00Z',
          uploadedAt: '2026-09-27T15:40:00Z',
        }),
      ]),
    });
    const region = screen.getByRole('region', { name: 'Exception photos' });
    expect(region).toHaveTextContent('Bottom row');
    expect(region).toHaveTextContent('Added by Dana Lee');
    expect(region).toHaveTextContent(
      "Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)",
    );
  });

  it('a failed read says so and offers a retry, never "No photos yet."', async () => {
    renderPanel({ evidence: { status: 'unavailable' } });
    expect(screen.getByRole('alert')).toHaveTextContent(EXCEPTION_EVIDENCE_UNAVAILABLE_COPY);
    expect(screen.queryByText(EXCEPTION_EVIDENCE_NONE_COPY)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('OccurrencePhotos: removing', () => {
  it('asks first, says the file is kept, and sends the reason', async () => {
    remove.mockResolvedValue({
      ok: true,
      evidence: { id: 'ph-1', removedAt: '2026-09-27T18:00:00Z' },
    });
    renderPanel({ evidence: evidence([photo()]) });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Photo 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(EXCEPTION_EVIDENCE_REMOVE_COPY);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: '  Blurry  ' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith(OCC, 'ph-1', 'Blurry');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('no reason is sent as null', async () => {
    remove.mockResolvedValue({
      ok: true,
      evidence: { id: 'ph-1', removedAt: '2026-09-27T18:00:00Z' },
    });
    renderPanel({ evidence: evidence([photo()]) });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Photo 1' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove photo' }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith(OCC, 'ph-1', null));
  });

  it('a refusal shows inline and the dialog stays open', async () => {
    remove.mockResolvedValue({
      error: {
        message: 'Only the person who added a photo, or a manager, can remove it.',
        reason: null,
      },
    });
    renderPanel({ evidence: evidence([photo()]) });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Photo 1' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only the person who added a photo, or a manager, can remove it.',
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a lost answer says to check the connection', async () => {
    remove.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPanel({ evidence: evidence([photo()]) });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Photo 1' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(EVIDENCE_CONNECTION_COPY);
  });
});
