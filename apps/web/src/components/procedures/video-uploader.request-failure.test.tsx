import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, recordEscapedRejections, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40 (a sibling of the item photo uploader): a video added to a saved
// procedure. A request that got no answer (offline, a server error, a deploy)
// showed the browser's own words ("Failed to fetch"), and the page was then
// read again whatever happened. With no connection that read is a full page
// load (the browser's offline page), which took the message with it. Now the
// page is read again only when a video was saved, the sentence says what did
// not happen, and a video whose record step got no answer says to look first.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ remove: vi.fn(async () => ({ error: null })) }) },
  }),
}));
// The PUT is the browser's XHR and the poster the browser's canvas.
vi.mock('./upload-video-master', () => ({
  uploadVideoMaster: vi.fn(async () => ({ ok: true, status: 200 })),
}));
vi.mock('./capture-poster', () => ({ captureVideoPoster: vi.fn(async () => null) }));
vi.mock('@/server/actions/procedures', () => ({
  createProcedureVideoUploadAction: vi.fn(),
  recordProcedureVideoAction: vi.fn(),
  deleteProcedureVideoAction: vi.fn(),
}));

import { toast } from 'sonner';

import {
  createProcedureVideoUploadAction,
  recordProcedureVideoAction,
} from '@/server/actions/procedures';

import { VideoUploader } from './video-uploader';

const PRESIGN = {
  ok: true,
  data: {
    path: 'org/p1/clip.mp4',
    signedUrl: 'https://storage.example.com/upload/clip',
    posterPath: 'org/p1/clip.jpg',
    posterSignedUrl: 'https://storage.example.com/upload/clip-poster',
  },
} as never;

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
  // The duration probe gives up at once (no <video> decoding here).
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    throw new Error('not supported in test env');
  });
});

function addVideos(...names: string[]) {
  render(
    <VideoUploader mode="immediate" procedureId="p1" organizationId="org-1" initialVideos={[]} />,
  );
  const input = document.getElementById('video-upload') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: names.map((n) => new File([new Uint8Array(64)], n, { type: 'video/mp4' })),
    configurable: true,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('VideoUploader on a saved procedure when a request gets no answer', () => {
  it('says the video was not uploaded, and leaves the page as it is', async () => {
    vi.mocked(createProcedureVideoUploadAction).mockRejectedValueOnce(offline());
    addVideos('clip.mp4');
    const sentence = requestFailedMessage(offline(), 'upload "clip.mp4"');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    expect(await screen.findByText('Failed: no answer')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    // With no connection a refresh is a full page load (the browser's offline
    // page), which would take the message with it.
    await new Promise((r) => setTimeout(r, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a video whose record step gets no answer says to check the videos before adding it again', async () => {
    vi.mocked(createProcedureVideoUploadAction).mockResolvedValueOnce(PRESIGN);
    vi.mocked(recordProcedureVideoAction).mockRejectedValueOnce(offline());
    addVideos('clip.mp4');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), '"clip.mp4" was saved', "the procedure's videos"),
      ),
    );
    expect(await screen.findByText('Not confirmed')).toBeInTheDocument();
    expect(screen.queryByText(/^Failed:/)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads the page again when one video was saved, while another got no answer', async () => {
    vi.mocked(createProcedureVideoUploadAction)
      .mockResolvedValueOnce(PRESIGN)
      .mockRejectedValueOnce(offline());
    vi.mocked(recordProcedureVideoAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'v1' },
    } as never);
    addVideos('clip.mp4', 'second.mp4');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Video uploaded.'));
    expect(toast.error).toHaveBeenCalledWith(
      requestFailedMessage(offline(), 'upload "second.mp4"'),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says nothing on the way to sign-in, and nothing is left to escape', async () => {
    vi.mocked(createProcedureVideoUploadAction).mockRejectedValueOnce(signInRedirect());
    addVideos('clip.mp4');
    await waitFor(() => expect(createProcedureVideoUploadAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
