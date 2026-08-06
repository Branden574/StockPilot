import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMaintenanceRequest,
  finalizePhoto,
  getMaintenanceRequest,
  listMaintenanceRequests,
  mintPhotoUpload,
  recordDraftOpened,
} from './maintenance-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under the node test environment.
// vi.mock/vi.hoisted are hoisted above the imports by vitest's transform, so
// declaring them AFTER the import block above keeps import order lint-clean
// while still intercepting './maintenance-api's own import of './api' (same
// idiom as item-create.test.ts).
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockClear());

describe('listMaintenanceRequests', () => {
  it('GETs scope=mine with no q param when none is given', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'mine' });
    expect(apiMock.api).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/maintenance-requests?scope=mine'),
    );
    const calledPath = apiMock.api.mock.calls[0]?.[0] as string;
    expect(calledPath).not.toContain('q=');
  });

  it('GETs scope=all', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'all' });
    expect(apiMock.api).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/maintenance-requests?scope=all'),
    );
  });

  it('unwraps the { requests } envelope', async () => {
    const rows = [{ id: 'r-1' }];
    apiMock.api.mockResolvedValueOnce({ requests: rows });
    await expect(listMaintenanceRequests({ scope: 'all' })).resolves.toEqual(rows);
  });

  it('forwards a trimmed q param', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'all', q: '  broken light  ' });
    const calledPath = apiMock.api.mock.calls[0]?.[0] as string;
    expect(calledPath).toContain('scope=all');
    expect(calledPath).toContain('q=broken+light');
  });

  it('omits q entirely for a blank/whitespace-only search', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'mine', q: '   ' });
    const calledPath = apiMock.api.mock.calls[0]?.[0] as string;
    expect(calledPath).not.toContain('q=');
  });

  it('never sends limit or offset — the route accepts neither (Task 11 fixed contract)', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'mine' });
    const calledPath = apiMock.api.mock.calls[0]?.[0] as string;
    expect(calledPath).not.toContain('limit');
    expect(calledPath).not.toContain('offset');
  });
});

describe('getMaintenanceRequest', () => {
  it('GETs the detail route and returns it verbatim', async () => {
    const payload = { request: {}, photos: [], emailInput: {}, canManage: false };
    apiMock.api.mockResolvedValueOnce(payload);
    await expect(getMaintenanceRequest('req-1')).resolves.toEqual(payload);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1');
  });
});

describe('createMaintenanceRequest', () => {
  it('POSTs the form values verbatim, unmodified', async () => {
    apiMock.api.mockResolvedValueOnce({ id: 'new-1' });
    const values = {
      subject: 'AC not working in Room 204',
      description: 'The AC unit stopped blowing cold air this morning.',
    } as never;
    await expect(createMaintenanceRequest(values)).resolves.toEqual({ id: 'new-1' });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests', {
      method: 'POST',
      body: values,
    });
  });
});

describe('recordDraftOpened', () => {
  it('POSTs the draft-opened route and returns the open count', async () => {
    apiMock.api.mockResolvedValueOnce({ openCount: 2 });
    await expect(recordDraftOpened('req-1')).resolves.toEqual({ openCount: 2 });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/draft-opened', {
      method: 'POST',
    });
  });
});

describe('mintPhotoUpload', () => {
  it('POSTs fileExt + originalFilename to the mint route', async () => {
    const payload = {
      path: 'org-1/req-1/uuid.jpg',
      signedUrl: 'https://signed/master',
      token: 'tok',
      thumbPath: 'org-1/req-1/uuid-thumb.webp',
      thumbSignedUrl: 'https://signed/thumb',
      thumbToken: 'thumb-tok',
    };
    apiMock.api.mockResolvedValueOnce(payload);
    await expect(
      mintPhotoUpload('req-1', { fileExt: 'jpg', originalFilename: 'photo.jpg' }),
    ).resolves.toEqual(payload);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/attachments', {
      method: 'POST',
      body: { fileExt: 'jpg', originalFilename: 'photo.jpg' },
    });
  });
});

describe('finalizePhoto', () => {
  it('POSTs only path/originalFilename/declaredMime — thumbPath is NEVER forwarded (route contract, CRITICAL 1c)', async () => {
    apiMock.api.mockResolvedValueOnce({ id: 'att-1' });
    await expect(
      finalizePhoto('req-1', {
        path: 'org-1/req-1/uuid.jpg',
        thumbPath: 'org-1/req-1/uuid-thumb.webp',
        originalFilename: 'photo.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).resolves.toEqual({ id: 'att-1' });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/maintenance-requests/req-1/attachments/finalize',
      {
        method: 'POST',
        body: {
          path: 'org-1/req-1/uuid.jpg',
          originalFilename: 'photo.jpg',
          declaredMime: 'image/jpeg',
        },
      },
    );
    // The mutation this pin catches: a future edit that spreads `args`
    // straight into the body would silently reintroduce thumbPath.
    const body = apiMock.api.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty('thumbPath');
  });

  it('accepts a null thumbPath the same way (still never sent)', async () => {
    apiMock.api.mockResolvedValueOnce({ id: 'att-2' });
    await finalizePhoto('req-1', {
      path: 'org-1/req-1/uuid2.png',
      thumbPath: null,
      originalFilename: 'photo2.png',
      declaredMime: 'image/png',
    });
    const body = apiMock.api.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty('thumbPath');
  });
});

/**
 * WIRING PINS for app/(drawer)/maintenance.tsx. That screen imports native
 * modules (expo-router, react-native) at top level, so the vitest config
 * excludes app/ from compilation (see vitest.config.ts); these source-level
 * assertions pin the load-bearing rules a fresh edit could silently drop —
 * same idiom as item-create.test.ts's "app/item/new.tsx is wired to the
 * shared create path" block.
 */
describe('app/(drawer)/maintenance.tsx is wired to the module gate + accurate language', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/(drawer)/maintenance.tsx'),
    'utf8',
  );

  it('reads the shared module registry, not a bespoke check', () => {
    expect(src).toContain('useEnabledModules');
    expect(src).toMatch(/\.has\(['"]maintenance_requests['"]\)/);
  });

  it('the module-off branch renders BEFORE the list ever loads (unreachable + invisible when off)', () => {
    // The load() callback must early-return while the module is off, and
    // that early-return must appear before the actual CALL (not just the
    // import line, which is always near the top) in source order —
    // otherwise "invisible when off" is cosmetic only and a disabled org
    // still fires the request.
    const callSite = src.indexOf('await listMaintenanceRequests(');
    const earlyReturnGuard = src.search(/if\s*\(\s*!enabled\s*\)/);
    expect(earlyReturnGuard).toBeGreaterThan(-1);
    expect(callSite).toBeGreaterThan(-1);
    expect(earlyReturnGuard).toBeLessThan(callSite);
  });

  it('renders the brief section 22 note verbatim', () => {
    expect(src).toContain(
      'Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.',
    );
  });

  it('never renders forbidden vocabulary implying an outcome StockPilot cannot observe (brief section 20)', () => {
    const FORBIDDEN = [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
    ];
    for (const banned of FORBIDDEN) {
      expect(src).not.toContain(banned);
    }
  });

  it('gates the all-org scope on read_all/manage, not submit alone', () => {
    expect(src).toContain('maintenance_requests:read_all');
    expect(src).toContain('maintenance_requests:manage');
  });

  it('gates the New-request affordance on submit', () => {
    expect(src).toContain('maintenance_requests:submit');
  });

  it('derives status labels from MAINTENANCE_STATUS_LABELS, never a hand-copied literal', () => {
    expect(src).toContain('MAINTENANCE_STATUS_LABELS');
  });

  it('formats the request handle through the shared formatter, never a raw number', () => {
    expect(src).toContain('formatMaintenanceRequestNumber');
  });
});
