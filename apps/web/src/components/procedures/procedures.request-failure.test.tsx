import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: Procedures. Archive and Restore closed their confirm in `finally`, so a
// failure shut it and said nothing it could be read in; Post comment, Save
// and Delete on a comment, Remove video and the procedure form cleared their
// flag in `finally` with no catch, so a call that got no answer (offline, a
// server error, a deploy) said nothing at all, and the form looked as if it
// had saved. Now each says what did not happen, inside the confirm where
// there is one; the confirm stays open and can be closed; a redirect to
// sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh, replace, back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ remove: vi.fn(async () => ({ error: null })) }) },
  }),
}));
// Only BatchProgress is replaced, so a test can make the staged-video batch
// stop after the procedure was created.
const batchBreaks = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/upload-with-progress', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/upload-with-progress')>();
  return {
    ...real,
    BatchProgress: class extends real.BatchProgress {
      constructor(...args: ConstructorParameters<typeof real.BatchProgress>) {
        if (batchBreaks.on) throw new Error('batch stopped');
        super(...args);
      }
    },
  };
});
vi.mock('@/server/actions/procedures', () => ({
  archiveProcedureAction: vi.fn(),
  restoreProcedureAction: vi.fn(),
  createProcedureCommentAction: vi.fn(),
  updateProcedureCommentAction: vi.fn(),
  deleteProcedureCommentAction: vi.fn(),
  createProcedureAction: vi.fn(),
  updateProcedureAction: vi.fn(),
  createProcedureVideoUploadAction: vi.fn(),
  recordProcedureVideoAction: vi.fn(),
  deleteProcedureVideoAction: vi.fn(),
}));

import { toast } from 'sonner';

import {
  archiveProcedureAction,
  createProcedureAction,
  createProcedureCommentAction,
  deleteProcedureCommentAction,
  deleteProcedureVideoAction,
  restoreProcedureAction,
  updateProcedureAction,
  updateProcedureCommentAction,
} from '@/server/actions/procedures';

import { ArchiveButton } from './archive-button';
import { CommentComposer } from './comment-composer';
import { CommentThread, type CommentView } from './comment-thread';
import { PROCEDURE_CREATED_VIDEOS_UNFINISHED, ProcedureForm } from './procedure-form';
import { RestoreButton } from './restore-button';
import { VideoUploader, type UploadedVideo } from './video-uploader';

beforeEach(() => {
  vi.clearAllMocks();
  batchBreaks.on = false;
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets a rejected call's catch and finally run. */
async function settle(call: () => void) {
  await waitFor(call);
  await new Promise((r) => setTimeout(r, 20));
}

async function confirmIn(user: UserEvent, opener: string | RegExp, confirm: string) {
  await user.click(screen.getByRole('button', { name: opener }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: confirm }));
  return dialog;
}

describe('Archive and Restore a procedure when the request gets no answer', () => {
  it('Archive says why inside the confirm, which stays open and can be closed', async () => {
    vi.mocked(archiveProcedureAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<ArchiveButton procedureId="p1" />);
    const dialog = await confirmIn(user, /Archive/, 'Archive');
    const sentence = requestFailedMessage(offline(), 'archive the procedure');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    expect(push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Opened again, it does not show the last try's reason.
    await user.click(screen.getByRole('button', { name: /Archive/ }));
    expect(within(await screen.findByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  it('a refused Archive also says why inside the confirm', async () => {
    vi.mocked(archiveProcedureAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'Only managers can archive procedures.' },
    } as never);
    const user = userEvent.setup();
    render(<ArchiveButton procedureId="p1" />);
    const dialog = await confirmIn(user, /Archive/, 'Archive');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only managers can archive procedures.',
    );
  });

  it('Restore says why inside the confirm, which stays open', async () => {
    vi.mocked(restoreProcedureAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<RestoreButton procedureId="p1" title="Replace a ballast" />);
    const dialog = await confirmIn(user, /Restore/, 'Restore');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'restore the procedure'),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(archiveProcedureAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(<ArchiveButton procedureId="p1" />);
    const dialog = await confirmIn(user, /Archive/, 'Archive');
    await settle(() => expect(archiveProcedureAction).toHaveBeenCalled());
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: 'c1',
    procedure_id: 'p1',
    body: 'Photograph damaged cartons.',
    author: { id: 'u1', full_name: 'Sam Example', avatar_url: null },
    is_own: true,
    parent_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    replies: [],
    ...overrides,
  };
}

describe('procedure comments when a request gets no answer', () => {
  // A comment has no key: one posted before the answer was lost is posted
  // twice if sent again.
  it('Post keeps the comment and says to look before trying again', async () => {
    vi.mocked(createProcedureCommentAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<CommentComposer procedureId="p1" />);
    await user.type(screen.getByPlaceholderText('Add a comment…'), 'Check the seals.');
    await user.click(screen.getByRole('button', { name: /Post/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'your comment was posted', 'the comments'),
      ),
    );
    expect(screen.getByPlaceholderText('Add a comment…')).toHaveValue('Check the seals.');
    expect(screen.getByRole('button', { name: /Post/ })).toBeEnabled();
  });

  it('Save on an edit says the comment was not saved and keeps the edit open', async () => {
    vi.mocked(updateProcedureCommentAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment()]}
        canModerate={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the comment')),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('Delete says why inside the confirm, which stays open', async () => {
    vi.mocked(deleteProcedureCommentAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment()]}
        canModerate={false}
      />,
    );
    const dialog = await confirmIn(user, /Delete/, 'Delete');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete the comment'),
    );
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

describe('the procedure form when the save gets no answer', () => {
  function ui(mode: 'create' | 'edit' = 'create') {
    return (
      <ProcedureForm
        mode={mode}
        categories={[]}
        warehouses={[]}
        userId="user-1"
        organizationId="org-1"
        defaults={
          mode === 'edit'
            ? {
                id: 'p1',
                title: 'Replace a ballast',
                description: null,
                body: null,
                categoryId: null,
                authoringWarehouseId: null,
                updatedAt: '2026-10-01T00:00:00.000Z',
              }
            : undefined
        }
      />
    );
  }

  // A procedure has no key: one made before the answer was lost is a second
  // one if sent again.
  it('Create procedure keeps what was typed and says to look before trying again', async () => {
    vi.mocked(createProcedureAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(ui('create'));
    await user.type(screen.getByLabelText(/Title/i), 'Replace a ballast');
    await user.click(screen.getByRole('button', { name: /Create procedure/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the procedure was created', 'the procedures list'),
      ),
    );
    expect(screen.getByLabelText(/Title/i)).toHaveValue('Replace a ballast');
    expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  it('Save changes on an edit says the procedure was not saved', async () => {
    vi.mocked(updateProcedureAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(ui('edit'));
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the procedure'),
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('when the videos stop after the procedure was created, says it was created and where to go, never to try again', async () => {
    vi.mocked(createProcedureAction).mockResolvedValueOnce({
      ok: true,
      data: { id: '00000000-0000-4000-8000-000000000001' },
    } as never);
    batchBreaks.on = true;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('not supported in test env');
    });
    const user = userEvent.setup();
    render(ui('create'));
    await user.type(screen.getByLabelText(/Title/i), 'Replace a ballast');
    const input = document.getElementById('video-upload') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array(64)], 'one.mp4', { type: 'video/mp4' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(screen.getByDisplayValue('one')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Create procedure/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(PROCEDURE_CREATED_VIDEOS_UNFINISHED),
    );
    expect(PROCEDURE_CREATED_VIDEOS_UNFINISHED).not.toMatch(/try again/i);
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(updateProcedureAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(ui('edit'));
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await settle(() => expect(updateProcedureAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Remove video on a saved procedure when the request gets no answer', () => {
  const VIDEOS: UploadedVideo[] = [
    {
      id: 'v1',
      title: 'Intro',
      storage_path: 'org-1/p1/v1.mp4',
      signed_url: null,
      duration_seconds: 30,
      size_bytes: 1000,
      mime_type: 'video/mp4',
      order_idx: 0,
    },
  ];

  it('says why inside the confirm, keeps the video, and the confirm can be closed', async () => {
    vi.mocked(deleteProcedureVideoAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <VideoUploader
        mode="immediate"
        procedureId="p1"
        organizationId="org-1"
        initialVideos={VIDEOS}
      />,
    );
    const dialog = await confirmIn(user, 'Delete Intro', 'Remove');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'remove the video'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Delete Intro' })).toBeInTheDocument();
  });
});
