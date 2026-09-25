import { after } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The REAL scheduler (src/test/setup.ts replaces it with a no-op everywhere
 * else): a forced sync registered with after(), so the caller returns before
 * it starts; and outside a request, fire-and-forget rather than a thrown
 * "outside a request scope".
 */

vi.mock('next/server', () => ({ after: vi.fn() }));
const syncOrg = vi.hoisted(() => vi.fn(async () => ({ status: 'applied' })));
vi.mock('../exception-occurrences', () => ({ ExceptionOccurrencesService: { syncOrg } }));

const afterMock = vi.mocked(after);

async function realScheduler() {
  return (
    await vi.importActual<typeof import('./exception-sync-schedule')>('./exception-sync-schedule')
  ).scheduleExceptionSync;
}

beforeEach(() => {
  vi.clearAllMocks();
  afterMock.mockReset();
});

describe('scheduleExceptionSync', () => {
  it('registers the sync with after() and returns before it starts', async () => {
    const tasks: Array<() => unknown> = [];
    afterMock.mockImplementation((task) => {
      tasks.push(task as () => unknown);
    });
    const schedule = await realScheduler();

    const returned = schedule('org-1', 'cycle_count.post');

    expect(returned).toBeUndefined();
    expect(tasks).toHaveLength(1);
    expect(syncOrg).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(syncOrg).toHaveBeenCalledWith('org-1', { force: true, reason: 'cycle_count.post' });
  });

  it('Check now schedules an UNFORCED sync, so one that landed in between makes it a no-op', async () => {
    const tasks: Array<() => unknown> = [];
    afterMock.mockImplementation((task) => {
      tasks.push(task as () => unknown);
    });
    const schedule = await realScheduler();
    schedule('org-1', 'check_now', { force: false });
    await tasks[0]!();
    expect(syncOrg).toHaveBeenCalledWith('org-1', { force: false, reason: 'check_now' });
  });

  it('outside a request it runs without throwing, and a failing sync never escapes', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    syncOrg.mockRejectedValueOnce(new Error('never happens: syncOrg does not throw'));
    const schedule = await realScheduler();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => schedule('org-1', 'check_now')).not.toThrow();
      await vi.waitFor(() => expect(syncOrg).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
