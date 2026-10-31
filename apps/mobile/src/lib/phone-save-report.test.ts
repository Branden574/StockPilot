import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboxOwnerUnknownError, OutboxWorkspaceLoadingError } from './outbox-scope';
import { reportPhoneSaveFailure } from './phone-save-report';

/**
 * docket B10 review: the screens that now catch a failed save on the phone to
 * say why must still report a failing store, which used to reach Sentry as an
 * unhandled rejection. The outbox's two refusals are expected: never reported.
 */

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: sentry }));

beforeEach(() => {
  sentry.captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportPhoneSaveFailure', () => {
  it("reports the phone's store failing, tagged with the save", () => {
    const disk = new Error('SQLITE_FULL: database or disk is full');
    reportPhoneSaveFailure(disk, 'cycle-count.save');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(disk, {
      tags: { area: 'cycle-count.save' },
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("never reports the outbox's two refusals", () => {
    reportPhoneSaveFailure(new OutboxWorkspaceLoadingError(), 'cycle-count.scan');
    reportPhoneSaveFailure(new OutboxOwnerUnknownError(), 'bundle.distribute.queue');
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reports a thrown value that is not an error too', () => {
    reportPhoneSaveFailure('disk I/O error', 'cycle-count.save');
    expect(sentry.captureException).toHaveBeenCalledWith('disk I/O error', {
      tags: { area: 'cycle-count.save' },
    });
  });
});
