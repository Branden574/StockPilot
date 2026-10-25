import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { redirect, RedirectType } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The New procedure form saves the procedure first, then uploads each staged
 * video through two Server Actions. When the session ends partway through, the
 * next of those actions is answered with a redirect to sign-in, and the browser
 * loads /signin?redirect=/dashboard/procedures/new (the page the action was
 * sent from). The page unloads, and the new procedure's id with it.
 *
 * Before the redirect answer, the batch reported each failed file and went on
 * to the procedure's edit page with ?upload_recovery=1. Here the person must
 * still get there after signing in, not to an empty New procedure form that
 * would make a second procedure (procedures have no unique rule).
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  createProcedure: vi.fn(),
  createVideoUpload: vi.fn(),
  recordVideo: vi.fn(),
  uploadMaster: vi.fn(),
}));

// The real next/navigation, so redirect() makes Next's own error and
// isControlFlow() judges it with Next's own unstable_rethrow.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: h.push, replace: h.replace, refresh: h.refresh, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: h.toastError, success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ remove: vi.fn().mockResolvedValue({ error: null }) }) },
  }),
}));

vi.mock('./upload-video-master', () => ({
  uploadVideoMaster: (...a: unknown[]) => h.uploadMaster(...a),
}));

vi.mock('@/server/actions/procedures', () => ({
  createProcedureAction: (...a: unknown[]) => h.createProcedure(...a),
  createProcedureVideoUploadAction: (...a: unknown[]) => h.createVideoUpload(...a),
  recordProcedureVideoAction: (...a: unknown[]) => h.recordVideo(...a),
  updateProcedureAction: vi.fn(),
  deleteProcedureVideoAction: vi.fn(),
}));

import {
  INTERRUPTED_RUN_PREFIX,
  INTERRUPTED_RUN_TTL_MS,
  purgeInterruptedRuns,
  sweepInterruptedRuns,
} from '@/lib/interrupted-run';
import { interruptedRunKeys } from '@/test/interrupted-run-fixtures';

import { ProcedureForm } from './procedure-form';

const PROCEDURE_ID = '00000000-0000-4000-8000-000000000001';
const RECOVERY_HREF = `/dashboard/procedures/${PROCEDURE_ID}/edit?upload_recovery=1`;
const ME = { userId: 'user-1', organizationId: 'org-1' };

/** The redirect a Server Action rejects with when the session has ended. */
function signInRedirect(): unknown {
  try {
    redirect('/signin?redirect=%2Fdashboard%2Fprocedures%2Fnew', RedirectType.push);
  } catch (e) {
    return e;
  }
  throw new Error('redirect() did not throw');
}

function presigned(procedureId: string) {
  return {
    ok: true,
    data: {
      path: `org-1/${procedureId}/video.mp4`,
      signedUrl: 'https://signed/master',
      posterPath: `org-1/${procedureId}/video.poster.jpg`,
      posterSignedUrl: 'https://signed/poster',
    },
  };
}

function renderNewForm(account = ME) {
  return render(
    <ProcedureForm
      mode="create"
      categories={[]}
      warehouses={[]}
      userId={account.userId}
      organizationId={account.organizationId}
    />,
  );
}

/** A promise the test settles itself: a Server Action still on its way. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFile(name: string): File {
  return new File([new Uint8Array(64)], name, { type: 'video/mp4' });
}

/** Fill in a title, stage two videos and press Create procedure. */
async function createWithTwoVideos() {
  renderNewForm();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/Title/i), 'Replace a ballast');
  const input = document.getElementById('video-upload') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [makeFile('one.mp4'), makeFile('two.mp4')],
    configurable: true,
  });
  fireEvent.change(input);
  await waitFor(() => expect(screen.getByDisplayValue('two')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: /Create procedure/i }));
}

beforeEach(() => {
  sessionStorage.clear();
  for (const fn of Object.values(h)) fn.mockReset();
  h.createProcedure.mockResolvedValue({ ok: true, data: { id: PROCEDURE_ID } });
  h.createVideoUpload.mockImplementation(async ({ procedureId }: { procedureId: string }) =>
    presigned(procedureId),
  );
  h.uploadMaster.mockResolvedValue({ ok: true, status: 200 });
  h.recordVideo.mockResolvedValue({ ok: true, data: {} });
  // happy-dom never loads a fake video's metadata; make the probe give up.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    throw new Error('not supported in test env');
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // A batch a test leaves going in this page would hold the next test's form.
  purgeInterruptedRuns();
});

describe('ProcedureForm: the session ends while staged videos upload', () => {
  it('after signing in, the New procedure page goes on to the procedure that was saved', async () => {
    // The first video lands; the second one's upload is refused with the
    // redirect to sign-in.
    h.createVideoUpload
      .mockImplementationOnce(async ({ procedureId }: { procedureId: string }) =>
        presigned(procedureId),
      )
      .mockRejectedValueOnce(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );

    // Nothing is shown on the way to sign-in, and the form sends the browser
    // nowhere itself: the router is already going there.
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.recordVideo).toHaveBeenCalledTimes(1);

    // The browser loads sign-in; after signing in, the person is back on
    // /dashboard/procedures/new.
    cleanup();
    renderNewForm();

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(RECOVERY_HREF));
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it('a reload partway through the batch also lands on the procedure', async () => {
    let finishUpload: (v: unknown) => void = () => {};
    h.createVideoUpload
      .mockImplementationOnce(async ({ procedureId }: { procedureId: string }) =>
        presigned(procedureId),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishUpload = resolve;
          }),
      );

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(2));

    // The reload: this page's modules start afresh, the tab's sessionStorage
    // stays.
    cleanup();
    vi.resetModules();
    const { ProcedureForm: ReloadedForm } = await import('./procedure-form');
    render(
      <ReloadedForm
        mode="create"
        categories={[]}
        warehouses={[]}
        userId={ME.userId}
        organizationId={ME.organizationId}
      />,
    );

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(RECOVERY_HREF));

    // (A real reload ends the old batch; here it is let finish.)
    finishUpload(presigned(PROCEDURE_ID));
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith(`/dashboard/procedures/${PROCEDURE_ID}`),
    );
  });

  it('a redirect while recording a video keeps the way back too, however long the upload took', async () => {
    // The second upload runs past an hour: the record must be fresh from the
    // step right before the recording, not from before the upload.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h.uploadMaster
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockImplementationOnce(async () => {
        now += INTERRUPTED_RUN_TTL_MS + 60_000;
        return { ok: true, status: 200 };
      });
    h.recordVideo
      .mockResolvedValueOnce({ ok: true, data: {} })
      .mockRejectedValueOnce(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.recordVideo).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();

    cleanup();
    renderNewForm();

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(RECOVERY_HREF));
  });

  it('a redirect on the first video, before any landed, still leads to the procedure', async () => {
    h.createVideoUpload.mockReset().mockRejectedValue(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );
    expect(h.replace).not.toHaveBeenCalled();

    cleanup();
    renderNewForm();

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(RECOVERY_HREF));
  });

  it('another account signing in on this tab is not sent to it', async () => {
    h.createVideoUpload.mockReset().mockRejectedValue(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );
    expect(h.replace).not.toHaveBeenCalled();

    cleanup();
    renderNewForm({ userId: 'user-2', organizationId: 'org-1' });
    // Let the mount effect run.
    await new Promise((r) => setTimeout(r, 0));

    expect(h.replace).not.toHaveBeenCalled();
  });

  it('a batch that ends on the page leaves nothing behind', async () => {
    await createWithTwoVideos();
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith(`/dashboard/procedures/${PROCEDURE_ID}`),
    );

    // Nothing is left in this tab for a later visit.
    expect(sessionStorage.length).toBe(0);
    cleanup();
    renderNewForm();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.replace).not.toHaveBeenCalled();
  });

  it('a batch with an ordinary failure still goes to the edit page itself, and leaves nothing behind', async () => {
    h.uploadMaster
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await createWithTwoVideos();
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(RECOVERY_HREF));
    expect(h.toastError).toHaveBeenCalledTimes(1);

    // Nothing is left in this tab for a later visit.
    expect(sessionStorage.length).toBe(0);
    cleanup();
    renderNewForm();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.replace).not.toHaveBeenCalled();
  });

  it('opening New procedure again while the batch still runs in this page does not leave it', async () => {
    let finishUpload: (v: unknown) => void = () => {};
    h.createVideoUpload
      .mockImplementationOnce(async ({ procedureId }: { procedureId: string }) =>
        presigned(procedureId),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishUpload = resolve;
          }),
      );

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(2));

    // A second New procedure form, while the first one's batch is still going.
    const second = render(
      <ProcedureForm
        mode="create"
        categories={[]}
        warehouses={[]}
        userId={ME.userId}
        organizationId={ME.organizationId}
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(h.replace).not.toHaveBeenCalled();
    second.unmount();

    finishUpload(presigned(PROCEDURE_ID));
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith(`/dashboard/procedures/${PROCEDURE_ID}`),
    );
  });

  it('a sign-out on purpose while the videos upload leaves nothing: New procedure opens empty after signing in', async () => {
    // B12 round 2. The account menu's Sign out (or a revoke) purges the tab's
    // records while the batch is still going in this page. The batch runs on
    // for a moment (the upload finishes) and would record its next step
    // before the recording that the ended session answers with a redirect.
    let finishPresign: (v: unknown) => void = () => {};
    h.createVideoUpload
      .mockImplementationOnce(async ({ procedureId }: { procedureId: string }) =>
        presigned(procedureId),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPresign = resolve;
          }),
      );
    h.recordVideo
      .mockResolvedValueOnce({ ok: true, data: {} })
      .mockRejectedValueOnce(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(2));
    expect(interruptedRunKeys()).toEqual([`${INTERRUPTED_RUN_PREFIX}procedure-video-batch`]);

    purgeInterruptedRuns();
    expect(interruptedRunKeys()).toEqual([]);

    finishPresign(presigned(PROCEDURE_ID));
    await waitFor(() => expect(h.recordVideo).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );
    expect(interruptedRunKeys()).toEqual([]);

    cleanup();
    renderNewForm();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.replace).not.toHaveBeenCalled();
  });

  it('a sign-out on purpose while the procedure is being saved leaves nothing: New procedure opens empty after signing in', async () => {
    // The batch used to join the page's runs only at its first record, after
    // the save came back, so a sign-out while the save was on its way found
    // nothing to stop: the save landed, the batch recorded its procedure, and
    // the refused upload kept that record for after signing in.
    const save = deferred<unknown>();
    h.createProcedure.mockImplementation(() => save.promise);
    // The session ended with the sign-out: the first upload is refused.
    h.createVideoUpload.mockRejectedValue(signInRedirect());

    await createWithTwoVideos();
    await waitFor(() => expect(h.createProcedure).toHaveBeenCalledTimes(1));
    expect(interruptedRunKeys()).toEqual([]);

    purgeInterruptedRuns();
    save.resolve({ ok: true, data: { id: PROCEDURE_ID } });

    await waitFor(() => expect(h.createVideoUpload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
    );
    expect(interruptedRunKeys()).toEqual([]);

    cleanup();
    renderNewForm();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.replace).not.toHaveBeenCalled();
  });

  it('an organization switch while the procedure is being saved: the batch keeps no record for the first organization', async () => {
    // The shell rendering for another account (here the same person in
    // another organization) stops a batch whose save is still on its way.
    const save = deferred<unknown>();
    h.createProcedure.mockImplementation(() => save.promise);
    let keysAtFirstUpload: string[] | null = null;
    h.createVideoUpload.mockImplementation(async ({ procedureId }: { procedureId: string }) => {
      keysAtFirstUpload ??= interruptedRunKeys();
      return presigned(procedureId);
    });

    await createWithTwoVideos();
    await waitFor(() => expect(h.createProcedure).toHaveBeenCalledTimes(1));
    sweepInterruptedRuns({ userId: ME.userId, organizationId: 'org-2' });
    save.resolve({ ok: true, data: { id: PROCEDURE_ID } });

    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith(`/dashboard/procedures/${PROCEDURE_ID}`),
    );
    expect(keysAtFirstUpload).toEqual([]);
    expect(interruptedRunKeys()).toEqual([]);
  });

  it('a redirect answering the save itself shows nothing, keeps nothing and is not left unhandled', async () => {
    // The session ended before the procedure was saved: nothing exists to go
    // back to, and the router is already on its way to sign-in.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      h.createProcedure.mockRejectedValue(signInRedirect());

      await createWithTwoVideos();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Create procedure/i })).toBeEnabled(),
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
      expect(h.toastError).not.toHaveBeenCalled();
      expect(h.push).not.toHaveBeenCalled();
      expect(h.createVideoUpload).not.toHaveBeenCalled();
      expect(interruptedRunKeys()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
