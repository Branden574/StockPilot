import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn(async () => ({ error: null })),
        remove: vi.fn(async () => ({ error: null })),
      }),
    },
  }),
}));

vi.mock('@/server/actions/procedures', () => ({
  recordProcedureVideoAction: vi.fn(async () => ({ ok: true, data: {} })),
  deleteProcedureVideoAction: vi.fn(async () => ({ ok: true, data: undefined })),
}));

import { VideoUploader, type StagedVideo } from './video-uploader';

function makeFile(name: string, type = 'video/mp4', size = 1024): File {
  const f = new File([new Uint8Array(size)], name, { type });
  // happy-dom doesn't always honor the size from the array; force it.
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

beforeEach(() => {
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  // crypto.randomUUID in happy-dom returns a string; ensure it exists.
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      configurable: true,
    });
  }
  // happy-dom's <video> never fires onloadedmetadata for a fake File. Force
  // probeVideoMetadata into the catch branch (resolves with duration=null)
  // by making createObjectURL throw.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    throw new Error('not supported in test env');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('VideoUploader — staged mode', () => {
  async function dropFiles(input: HTMLInputElement, files: File[]) {
    // happy-dom + userEvent.upload doesn't reliably fire onChange on
    // sr-only file inputs, so fire it directly. This mirrors the path the
    // file <input>'s onChange takes in the component.
    Object.defineProperty(input, 'files', {
      value: files,
      configurable: true,
    });
    fireEvent.change(input);
    // Allow the async stageFiles loop (probeVideoMetadata is async) to
    // settle.
    await new Promise((r) => setTimeout(r, 0));
  }

  it('rejects files with a disallowed mime type via toast.error and does not stage them', async () => {
    const onStagedChange = vi.fn();
    render(
      <VideoUploader
        mode="staged"
        staged={[]}
        onStagedChange={onStagedChange}
      />,
    );

    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [makeFile('x.txt', 'text/plain')]);

    expect(toastErrorMock).toHaveBeenCalled();
    expect(onStagedChange).toHaveBeenCalledWith([]);
  });

  it('rejects files over 500 MB', async () => {
    const onStagedChange = vi.fn();
    render(
      <VideoUploader
        mode="staged"
        staged={[]}
        onStagedChange={onStagedChange}
      />,
    );

    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [
      makeFile('big.mp4', 'video/mp4', 600 * 1024 * 1024),
    ]);

    expect(toastErrorMock).toHaveBeenCalled();
    expect(onStagedChange).toHaveBeenCalledWith([]);
  });

  it('stages a valid video file with default title = filename minus extension', async () => {
    const onStagedChange = vi.fn();
    render(
      <VideoUploader
        mode="staged"
        staged={[]}
        onStagedChange={onStagedChange}
      />,
    );

    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [makeFile('how-to-fix-it.mp4', 'video/mp4', 1024)]);

    expect(onStagedChange).toHaveBeenCalled();
    const next = onStagedChange.mock.calls.at(-1)?.[0] as StagedVideo[];
    expect(next).toHaveLength(1);
    expect(next[0]?.title).toBe('how-to-fix-it');
    expect(next[0]?.status).toBe('pending');
    expect(next[0]?.mimeType).toBe('video/mp4');
    expect(next[0]?.sizeBytes).toBe(1024);
  });

  it('renders an existing staged row with the title input and reorder/remove buttons', () => {
    const staged: StagedVideo[] = [
      {
        tempId: 't1',
        file: makeFile('a.mp4'),
        title: 'First',
        durationSeconds: 12,
        sizeBytes: 1024 * 1024,
        mimeType: 'video/mp4',
        status: 'pending',
      },
      {
        tempId: 't2',
        file: makeFile('b.mp4'),
        title: 'Second',
        durationSeconds: 30,
        sizeBytes: 2 * 1024 * 1024,
        mimeType: 'video/mp4',
        status: 'pending',
      },
    ];
    render(
      <VideoUploader
        mode="staged"
        staged={staged}
        onStagedChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('First')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Second')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Move .* up/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Move .* down/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Remove /i })).toHaveLength(2);
  });

  it('move-up on the second item swaps it with the first', async () => {
    const onStagedChange = vi.fn();
    const staged: StagedVideo[] = [
      {
        tempId: 't1',
        file: makeFile('a.mp4'),
        title: 'First',
        durationSeconds: 5,
        sizeBytes: 1024,
        mimeType: 'video/mp4',
        status: 'pending',
      },
      {
        tempId: 't2',
        file: makeFile('b.mp4'),
        title: 'Second',
        durationSeconds: 10,
        sizeBytes: 2048,
        mimeType: 'video/mp4',
        status: 'pending',
      },
    ];
    render(
      <VideoUploader
        mode="staged"
        staged={staged}
        onStagedChange={onStagedChange}
      />,
    );

    const upButtons = screen.getAllByRole('button', { name: /Move .* up/i });
    // The first item's up button is disabled; click the second's.
    const user = userEvent.setup();
    await user.click(upButtons[1]!);
    const next = onStagedChange.mock.calls.at(-1)?.[0] as StagedVideo[];
    expect(next[0]?.tempId).toBe('t2');
    expect(next[1]?.tempId).toBe('t1');
  });

  it('remove drops the entry from the list', async () => {
    const onStagedChange = vi.fn();
    const staged: StagedVideo[] = [
      {
        tempId: 't1',
        file: makeFile('a.mp4'),
        title: 'First',
        durationSeconds: 5,
        sizeBytes: 1024,
        mimeType: 'video/mp4',
        status: 'pending',
      },
    ];
    render(
      <VideoUploader
        mode="staged"
        staged={staged}
        onStagedChange={onStagedChange}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Remove /i }));
    expect(onStagedChange).toHaveBeenCalledWith([]);
  });

  it('disables remove/reorder when uploading=true', () => {
    const staged: StagedVideo[] = [
      {
        tempId: 't1',
        file: makeFile('a.mp4'),
        title: 'First',
        durationSeconds: 5,
        sizeBytes: 1024,
        mimeType: 'video/mp4',
        status: 'uploading',
      },
    ];
    render(
      <VideoUploader
        mode="staged"
        staged={staged}
        onStagedChange={vi.fn()}
        uploading
      />,
    );
    expect(screen.getByRole('button', { name: /Remove /i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move .* up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move .* down/i })).toBeDisabled();
  });
});
