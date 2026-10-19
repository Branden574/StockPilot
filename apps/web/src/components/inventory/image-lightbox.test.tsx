import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ImageLightbox } from './image-lightbox';

/**
 * The image viewer (item photos, maintenance and exception photos, order
 * proof). The redesign (P2.4) restyles its chrome; everything it does stays:
 * zoom, pan, arrows and keys, Download, Delete with its confirm, the failure
 * state with Try again. Two defects found on the way are pinned here.
 */

const A = { id: 'img-a', url: 'https://files.example.test/a.jpg', isPrimary: true };
const B = { id: 'img-b', url: 'https://files.example.test/b.jpg' };

function renderViewer(props: Partial<React.ComponentProps<typeof ImageLightbox>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ImageLightbox images={[A, B]} startIndex={0} open onClose={onClose} {...props} />,
  );
  return { onClose, ...utils };
}

function viewer() {
  return screen.getByRole('dialog', { name: 'Image viewer' });
}

/** The "1 of 2" counter: the span that holds the words (its "of" is a span of
 *  its own), with the spaces kept in its own text. */
function counter(text: string) {
  return within(viewer()).getByText(
    (_, el) =>
      el?.tagName === 'SPAN' &&
      el.firstChild?.nodeType === Node.TEXT_NODE &&
      el.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
}

describe('ImageLightbox keeps every control', () => {
  it('names where the image is in the set, and the primary image', () => {
    renderViewer();
    expect(within(viewer()).getByText('Primary')).toBeInTheDocument();
    expect(counter('1 of 2')).toBeInTheDocument();
  });

  it('zooms in and out by the buttons, between 100% and 400%', async () => {
    const user = userEvent.setup();
    renderViewer();
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    expect(zoomOut).toBeDisabled();
    expect(screen.getByText('100%')).toBeInTheDocument();
    await user.click(zoomIn);
    expect(screen.getByText('150%')).toBeInTheDocument();
    expect(zoomOut).toBeEnabled();
    for (let i = 0; i < 6; i++) await user.click(zoomIn);
    expect(screen.getByText('400%')).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();
    await user.click(zoomOut);
    expect(screen.getByText('350%')).toBeInTheDocument();
  });

  it('a click on the photo toggles 200% zoom', () => {
    renderViewer();
    const img = viewer().querySelector('img')!;
    fireEvent.click(img);
    expect(screen.getByText('200%')).toBeInTheDocument();
    fireEvent.click(img);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('pages by the arrow buttons and the arrow keys', async () => {
    const user = userEvent.setup();
    renderViewer();
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next image' }));
    expect(counter('2 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(counter('1 of 2')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(counter('2 of 2')).toBeInTheDocument();
  });

  it('downloads the full image under its file name', () => {
    renderViewer();
    const link = screen.getByRole('link', { name: 'Download image' });
    expect(link).toHaveAttribute('href', A.url);
    expect(link).toHaveAttribute('download', 'a.jpg');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('offers Delete only when the host passes onDelete', () => {
    const { unmount } = renderViewer();
    expect(screen.queryByRole('button', { name: 'Delete image' })).not.toBeInTheDocument();
    unmount();
    renderViewer({ onDelete: vi.fn() });
    expect(screen.getByRole('button', { name: 'Delete image' })).toBeInTheDocument();
  });

  it('Close and Escape close it; a press in the bar does not', async () => {
    const user = userEvent.setup();
    const { onClose } = renderViewer();
    await user.click(screen.getByText('Primary'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the spinner until the photo loads', () => {
    renderViewer();
    const img = viewer().querySelector('img')!;
    expect(viewer().querySelector('.animate-spin')).not.toBeNull();
    fireEvent.load(img);
    expect(viewer().querySelector('.animate-spin')).toBeNull();
  });

  it('draws no blur: the chrome is solid, so it reads over any photo', () => {
    renderViewer({ onDelete: vi.fn() });
    expect(document.body.innerHTML).not.toMatch(/backdrop-blur/);
  });

  // Defect caught in review: in light mode keyboard focus showed nothing on
  // Close and the arrows. The global ring sits outside a control (a 2px offset
  // in the page colour, then the ring), so the offset fell on the white chip
  // and the ink ring on the black viewing surface. Each control now draws the
  // ring inside itself, on its own surface, in both themes.
  it('draws the keyboard focus ring inside every control, on its own surface', () => {
    const C = { id: 'img-c', url: 'https://files.example.test/c.jpg' };
    renderViewer({ images: [A, B, C], startIndex: 1, onDelete: vi.fn() });
    const controls = [
      screen.getByRole('button', { name: 'Zoom out' }),
      screen.getByRole('button', { name: 'Zoom in' }),
      screen.getByRole('link', { name: 'Download image' }),
      screen.getByRole('button', { name: 'Delete image' }),
      screen.getByRole('button', { name: 'Close' }),
      screen.getByRole('button', { name: 'Previous image' }),
      screen.getByRole('button', { name: 'Next image' }),
    ];
    for (const control of controls) {
      expect(control).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
  });
});

describe('ImageLightbox: a photo that will not load', () => {
  const loadFailure = () => ({ message: 'This photo could not be loaded.', onRetry: vi.fn() });

  it('says so with Try again, instead of a spinner forever', () => {
    const failure = loadFailure();
    renderViewer({ loadFailure: failure });
    fireEvent.error(viewer().querySelector('img')!);
    expect(within(viewer()).getByRole('alert')).toHaveTextContent(
      'This photo could not be loaded.',
    );
    expect(viewer().querySelector('.animate-spin')).toBeNull();
  });

  // Mutation caught: the press bubbled to the viewer's own click-to-close, so
  // Try again closed the viewer while it asked for a fresh link, and the
  // retried photo was never shown.
  it('Try again retries and keeps the viewer open', async () => {
    const user = userEvent.setup();
    const failure = loadFailure();
    const { onClose } = renderViewer({ loadFailure: failure });
    fireEvent.error(viewer().querySelector('img')!);
    await user.click(within(viewer()).getByRole('button', { name: 'Try again' }));
    expect(failure.onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Defect found in the lab at 390 (P2.4c): with more than one photo the
  // failure card ran under the Next arrow (12px in from the edge, 44px wide)
  // while its own margin was 24px. With arrows shown it keeps 64px clear of
  // each edge below sm; a single photo has no arrows and keeps its 24px.
  it('keeps the failure card clear of the arrows on a phone', () => {
    renderViewer({ loadFailure: loadFailure() });
    fireEvent.error(viewer().querySelector('img')!);
    expect(screen.getByRole('button', { name: 'Next image' })).toHaveClass('right-3', 'size-11');
    expect(screen.getByTestId('image-viewer-failure')).toHaveClass('px-6', 'max-sm:px-16');
  });

  it('keeps the narrow margin when a single photo has no arrows', () => {
    renderViewer({ images: [A], loadFailure: loadFailure() });
    fireEvent.error(viewer().querySelector('img')!);
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
    expect(screen.getByTestId('image-viewer-failure')).toHaveClass('px-6');
    expect(screen.getByTestId('image-viewer-failure')).not.toHaveClass('max-sm:px-16');
  });
});

describe('ImageLightbox: Delete', () => {
  it('asks first, then removes the image on screen', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderViewer({ onDelete });
    await user.click(screen.getByRole('button', { name: 'Delete image' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(await screen.findByText('Remove this image?')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(onDelete).toHaveBeenCalledWith('img-a');
  });

  // Mutation caught: the arrow keys still paged the viewer behind the open
  // confirm, and the confirm then deleted whichever image the viewer showed
  // by then, not the one Delete was pressed on.
  it('removes the image Delete was pressed on, even after an arrow key behind the confirm', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderViewer({ onDelete });
    await user.click(screen.getByRole('button', { name: 'Delete image' }));
    await screen.findByText('Remove this image?');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('img-a');
    await waitFor(() => expect(screen.queryByText('Remove this image?')).not.toBeInTheDocument());
    expect(counter('1 of 2')).toBeInTheDocument();
  });

  // Defect found in the lab (P2.4c; the base build does the same): the
  // confirm is a dialog of its own with no trigger, so when it closed Radix
  // had nothing to hand focus back to and it fell to the page body. A
  // keyboard user lost their place in the viewer. It goes back to Delete,
  // whether the confirm was cancelled, escaped or the image removed.
  it('hands keyboard focus back to Delete when the confirm closes', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderViewer({ onDelete });
    const deleteButton = () => screen.getByRole('button', { name: 'Delete image' });

    await user.click(deleteButton());
    const confirm = await screen.findByRole('dialog', { name: 'Remove this image?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Remove this image?')).not.toBeInTheDocument());
    await waitFor(() => expect(deleteButton()).toHaveFocus());
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(deleteButton());
    await screen.findByRole('dialog', { name: 'Remove this image?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Remove this image?')).not.toBeInTheDocument());
    expect(viewer()).toBeInTheDocument();
    await waitFor(() => expect(deleteButton()).toHaveFocus());

    await user.click(deleteButton());
    await screen.findByRole('dialog', { name: 'Remove this image?' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(onDelete).toHaveBeenCalledWith('img-a');
    await waitFor(() => expect(screen.queryByText('Remove this image?')).not.toBeInTheDocument());
    await waitFor(() => expect(deleteButton()).toHaveFocus());
  });
});

describe('ImageLightbox: keyboard focus when it closes', () => {
  // Defect found in the P2.4c re-check (the base build does the same): the
  // viewer has no Radix trigger, since every caller opens it from its own
  // thumbnail button, so when it closed Radix had nothing to hand focus back
  // to and it fell to the page body. A keyboard user started again from the
  // top of the page. It goes back to the thumbnail that opened it.
  function Gallery({ keepMounted }: { keepMounted: boolean }) {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open image full screen
        </button>
        {keepMounted || open ? (
          <ImageLightbox
            images={[A, B]}
            startIndex={0}
            open={open}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    );
  }
  const viewerGone = () =>
    waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Image viewer' })).not.toBeInTheDocument(),
    );

  it.each([
    ['kept mounted while closed (maintenance photos)', true],
    ['mounted only while open (item photos, order proof)', false],
  ])('goes back to the thumbnail that opened it, %s', async (_, keepMounted) => {
    const user = userEvent.setup();
    render(<Gallery keepMounted={keepMounted} />);
    const opener = screen.getByRole('button', { name: 'Open image full screen' });

    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Image viewer' });
    await waitFor(() => expect(viewer()).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    await viewerGone();
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Image viewer' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await viewerGone();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  // The same walk in the development configuration (StrictMode is on in
  // next.config.ts, so React runs effects twice): focus stays in the viewer
  // while it is open, never bouncing out to the thumbnail (whose own focus
  // handlers would fire), and goes back to the thumbnail once, on close.
  it('does the same in the development configuration (StrictMode)', async () => {
    const user = userEvent.setup();
    render(
      <React.StrictMode>
        <Gallery keepMounted={false} />
      </React.StrictMode>,
    );
    const opener = screen.getByRole('button', { name: 'Open image full screen' });
    const onOpenerFocus = vi.fn();
    opener.addEventListener('focus', onOpenerFocus);
    await user.click(opener);
    expect(onOpenerFocus).toHaveBeenCalledTimes(1);
    await screen.findByRole('dialog', { name: 'Image viewer' });
    await new Promise((r) => setTimeout(r, 20));
    expect(viewer()).toContainElement(document.activeElement as HTMLElement);
    expect(onOpenerFocus).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await viewerGone();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onOpenerFocus).toHaveBeenCalledTimes(2);
  });
});
