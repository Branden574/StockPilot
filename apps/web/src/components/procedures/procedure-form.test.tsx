import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const refreshMock = vi.fn();
const createProcedureActionMock = vi.fn();
const createVideoUploadActionMock = vi.fn();
const recordProcedureVideoActionMock = vi.fn();
const uploadMasterMock = vi.fn();
const removeMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

// Only `remove` remains on the SDK client — the master upload goes through
// the presigned-URL + XHR PUT seam (upload-video-master.ts) now.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        remove: (...a: unknown[]) => removeMock(...a),
      }),
    },
  }),
}));

vi.mock('./upload-video-master', () => ({
  uploadVideoMaster: (...a: unknown[]) => uploadMasterMock(...a),
}));

vi.mock('@/server/actions/procedures', () => ({
  createProcedureAction: (...a: unknown[]) => createProcedureActionMock(...a),
  createProcedureVideoUploadAction: (...a: unknown[]) =>
    createVideoUploadActionMock(...a),
  recordProcedureVideoAction: (...a: unknown[]) =>
    recordProcedureVideoActionMock(...a),
  updateProcedureAction: vi.fn(),
  deleteProcedureVideoAction: vi.fn(),
}));

import { ProcedureForm } from './procedure-form';

function makeFile(name: string, type = 'video/mp4', size = 1024): File {
  const f = new File([new Uint8Array(size)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

async function dropFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
  // Let probeVideoMetadata's promise + the staging map settle.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  pushMock.mockReset();
  refreshMock.mockReset();
  createProcedureActionMock.mockReset();
  createVideoUploadActionMock.mockReset();
  recordProcedureVideoActionMock.mockReset();
  uploadMasterMock.mockReset();
  removeMock.mockReset();
  createVideoUploadActionMock.mockImplementation(
    async ({ procedureId }: { procedureId: string }) => ({
      ok: true,
      data: {
        path: `org-1/${procedureId}/uuid-1.mp4`,
        signedUrl: 'https://signed/master',
        token: 'tok',
        posterPath: `org-1/${procedureId}/uuid-1.poster.jpg`,
        posterSignedUrl: 'https://signed/poster',
      },
    }),
  );
  uploadMasterMock.mockResolvedValue({ ok: true, status: 200 });
  removeMock.mockResolvedValue({ error: null });
  recordProcedureVideoActionMock.mockResolvedValue({ ok: true, data: {} });

  // Ensure crypto.randomUUID exists in happy-dom.
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      configurable: true,
    });
  }
  // happy-dom's <video> never fires onloadedmetadata for a fake File. Force
  // probeVideoMetadata's catch branch so it resolves immediately with
  // duration=null.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    throw new Error('not supported in test env');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProcedureForm — create mode submit flow', () => {
  it('with no staged videos: creates the procedure and redirects to the detail page', async () => {
    createProcedureActionMock.mockResolvedValue({
      ok: true,
      data: { id: 'p-123' },
    });

    render(
      <ProcedureForm
        mode="create"
        categories={[]}
        warehouses={[]}
        organizationId="org-1"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Title/i), 'My SOP');
    await user.click(screen.getByRole('button', { name: /Create procedure/i }));

    await waitFor(() => {
      expect(createProcedureActionMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/procedures/p-123');
    });
    // No videos to upload.
    expect(createVideoUploadActionMock).not.toHaveBeenCalled();
    expect(uploadMasterMock).not.toHaveBeenCalled();
    expect(recordProcedureVideoActionMock).not.toHaveBeenCalled();
  });

  it('with staged videos: sequential uploads → record → redirect to detail page when all succeed', async () => {
    createProcedureActionMock.mockResolvedValue({
      ok: true,
      data: { id: 'p-456' },
    });

    render(
      <ProcedureForm
        mode="create"
        categories={[]}
        warehouses={[]}
        organizationId="org-1"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Title/i), 'My SOP');

    // Stage two files via the hidden input.
    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [makeFile('one.mp4'), makeFile('two.mp4')]);

    // Both rows now present.
    await waitFor(() => {
      expect(screen.getByDisplayValue('one')).toBeInTheDocument();
      expect(screen.getByDisplayValue('two')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Create procedure/i }));

    await waitFor(() => {
      expect(recordProcedureVideoActionMock).toHaveBeenCalledTimes(2);
    });

    // Sequential: orderIdx 0 then 1.
    const calls = recordProcedureVideoActionMock.mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      procedureId: 'p-456',
      orderIdx: 0,
      title: 'one',
    });
    expect(calls[1]?.[0]).toMatchObject({
      procedureId: 'p-456',
      orderIdx: 1,
      title: 'two',
    });

    // Each upload minted its presigned URL against the created procedure id,
    // then PUT the staged File itself through the honest-progress seam.
    expect(createVideoUploadActionMock).toHaveBeenCalledTimes(2);
    expect(createVideoUploadActionMock).toHaveBeenCalledWith({
      procedureId: 'p-456',
      fileExt: 'mp4',
    });
    expect(uploadMasterMock).toHaveBeenCalledTimes(2);
    const firstUpload = uploadMasterMock.mock.calls[0]?.[0] as {
      signedUrl: string;
      file: File;
      contentType: string;
      onProgress?: unknown;
    };
    expect(firstUpload.signedUrl).toBe('https://signed/master');
    expect(firstUpload.file).toBeInstanceOf(File);
    expect(firstUpload.contentType).toBe('video/mp4');
    // The batch percent is wired to real transport events.
    expect(firstUpload.onProgress).toBeInstanceOf(Function);
    // The recorded storage path is the SERVER-minted one.
    expect(recordProcedureVideoActionMock.mock.calls[0]?.[0]).toMatchObject({
      storagePath: 'org-1/p-456/uuid-1.mp4',
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/procedures/p-456');
    });
  });

  it('with a partial upload failure: redirects to the edit page with upload_recovery=1', async () => {
    createProcedureActionMock.mockResolvedValue({
      ok: true,
      data: { id: 'p-789' },
    });
    // First upload succeeds, second fails — a non-2xx from storage resolves
    // ok:false (upload-with-progress mirrors fetch's contract).
    uploadMasterMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    render(
      <ProcedureForm
        mode="create"
        categories={[]}
        warehouses={[]}
        organizationId="org-1"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Title/i), 'SOP');
    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [makeFile('ok.mp4'), makeFile('bad.mp4')]);

    await user.click(screen.getByRole('button', { name: /Create procedure/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        '/dashboard/procedures/p-789/edit?upload_recovery=1',
      );
    });

    // Only the successful storage upload led to a recordProcedureVideoAction
    // call.
    expect(recordProcedureVideoActionMock).toHaveBeenCalledTimes(1);
  });

  it('aborts when createProcedureAction fails — no uploads triggered', async () => {
    createProcedureActionMock.mockResolvedValue({
      ok: false,
      error: { code: 'validation_error', message: 'nope' },
    });

    render(
      <ProcedureForm
        mode="create"
        categories={[]}
        warehouses={[]}
        organizationId="org-1"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Title/i), 'SOP');
    const input = document.getElementById('video-upload') as HTMLInputElement;
    await dropFiles(input, [makeFile('a.mp4')]);

    await user.click(screen.getByRole('button', { name: /Create procedure/i }));

    await waitFor(() => {
      expect(createProcedureActionMock).toHaveBeenCalled();
    });
    expect(createVideoUploadActionMock).not.toHaveBeenCalled();
    expect(uploadMasterMock).not.toHaveBeenCalled();
    expect(recordProcedureVideoActionMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
