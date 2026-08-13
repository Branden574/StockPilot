import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaintenanceEmailInput } from '@stockpilot/core';

import {
  addMaintenanceNote,
  archiveMaintenanceRequest,
  assignMaintenanceOwner,
  createMaintenanceRequest,
  finalizePhoto,
  getMaintenanceRequest,
  listMaintenanceMembers,
  listMaintenanceNotes,
  listMaintenanceRequests,
  mintPhotoUpload,
  recordDraftOpened,
  resolveMaintenanceRequest,
  type MobileMaintenancePhoto,
  type MobileMaintenanceRequestDetail,
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

  it('forwards a status filter — LITERAL URL pin (Task 9)', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'mine', status: 'resolved' });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/maintenance-requests?scope=mine&status=resolved',
    );
  });

  it('forwards the synthetic "active" status value unchanged', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'all', status: 'active' });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/maintenance-requests?scope=all&status=active',
    );
  });

  it('omits the status param entirely when absent — never sends status=undefined', async () => {
    apiMock.api.mockResolvedValueOnce({ requests: [] });
    await listMaintenanceRequests({ scope: 'mine' });
    const calledPath = apiMock.api.mock.calls[0]?.[0] as string;
    expect(calledPath).not.toContain('status');
  });
});

/**
 * Detail/photo field mirror (Task 9). `MobileMaintenanceRequestDetail` and
 * `MobileMaintenancePhoto` are hand-declared mirrors of server-only
 * interfaces (maintenance-requests.ts's `MaintenanceRequestDetail`,
 * maintenance-attachments.ts's `SignedMaintenancePhoto`) that mobile cannot
 * import directly. `getMaintenanceRequest`'s `api()` call casts its result
 * `as T` with NO runtime validation, so a mirror interface that silently
 * drops a field is invisible until a screen renders `undefined` where a
 * real value belongs. This test builds a fully-typed canned response — a
 * payload literal missing `resolvedAt`/`resolvedByName`/`resolutionNote` on
 * `request` or `kind` on a photo is a COMPILE ERROR here, not a passing
 * test with a silently-undefined field — then proves the wrapper still
 * round-trips it verbatim (no transform of its own to get wrong).
 */
describe('getMaintenanceRequest — detail/photo field mirror (typecheck-forced, Task 9)', () => {
  it('round-trips the resolution fields and photo kind exactly as the server sends them', async () => {
    const request: MobileMaintenanceRequestDetail = {
      id: 'req-1',
      requestNumber: 42,
      createdAt: '2026-08-01T00:00:00.000Z',
      subject: 'AC not working in Room 204',
      status: 'resolved',
      priority: 'high',
      category: 'Heating or air conditioning',
      siteName: 'DC4',
      requesterName: 'Res Req',
      requesterUserId: 'user-1',
      photoCount: 2,
      draftOpened: true,
      localOwnerUserId: null,
      description: 'The AC unit stopped blowing cold air this morning.',
      requesterEmail: 'res-req@test.local',
      requesterPhone: null,
      charterId: 'charter-1',
      warehouseId: null,
      building: null,
      roomOrArea: null,
      department: null,
      accessInstructions: null,
      relatedItemId: null,
      relatedOrderRequestId: null,
      relatedRentalId: null,
      relatedLocationId: null,
      outlookDraftOpenedAt: '2026-08-01T01:00:00.000Z',
      outlookDraftOpenCount: 1,
      archivedAt: null,
      cancelledAt: null,
      resolvedAt: '2026-08-05T00:00:00.000Z',
      resolvedByName: 'Dana Keeler',
      resolutionNote: 'Replaced the leaking\nroof tile.',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const photos: MobileMaintenancePhoto[] = [
      {
        id: 'p-1',
        originalFilename: 'before.jpg',
        url: 'https://signed/p1',
        thumbUrl: 'https://signed/p1-thumb',
        width: 800,
        height: 600,
        kind: 'requester',
      },
      {
        id: 'p-2',
        originalFilename: 'after.jpg',
        url: 'https://signed/p2',
        thumbUrl: null,
        width: null,
        height: null,
        kind: 'resolution',
      },
    ];
    const payload = {
      request,
      photos,
      emailInput: {} as MaintenanceEmailInput,
      canManage: true,
    };
    apiMock.api.mockResolvedValueOnce(payload);
    const result = await getMaintenanceRequest('req-1');
    expect(result).toEqual(payload);
    // Field-for-field, not just deep-equal against the same object — a
    // future edit that swaps resolvedByName/resolutionNote would still pass
    // toEqual against a swapped fixture but fails these direct reads.
    expect(result.request.resolvedAt).toBe('2026-08-05T00:00:00.000Z');
    expect(result.request.resolvedByName).toBe('Dana Keeler');
    expect(result.request.resolutionNote).toBe('Replaced the leaking\nroof tile.');
    expect(result.photos[0]?.kind).toBe('requester');
    expect(result.photos[1]?.kind).toBe('resolution');
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

describe('resolveMaintenanceRequest', () => {
  it('POSTs { note } to the resolve route — literal path + body pin', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });
    await expect(resolveMaintenanceRequest('req-1', 'Replaced the leaking roof tile.')).resolves.toEqual({
      ok: true,
    });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/resolve', {
      method: 'POST',
      body: { note: 'Replaced the leaking roof tile.' },
    });
  });

  it('surfaces a 409 AS-IS (a genuine conflict, not rate-limiting) — no special-casing to swallow or reword it', async () => {
    class ApiError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.status = status;
      }
    }
    apiMock.api.mockRejectedValueOnce(new ApiError('This request is already resolved.', 409));
    const err = (await resolveMaintenanceRequest('req-1', 'Fixed it.').catch((e) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.message).toBe('This request is already resolved.');
  });
});

describe('archiveMaintenanceRequest', () => {
  it('POSTs the archive route with NO body — literal path pin', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });
    await expect(archiveMaintenanceRequest('req-1')).resolves.toEqual({ ok: true });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/archive', {
      method: 'POST',
    });
  });
});

describe('assignMaintenanceOwner', () => {
  it('POSTs { userId } to the assign-owner route — literal path pin', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });
    await expect(assignMaintenanceOwner('req-1', 'user-9')).resolves.toEqual({ ok: true });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/assign-owner', {
      method: 'POST',
      body: { userId: 'user-9' },
    });
  });

  it('round-trips a null userId as an EXPLICIT null, not omitted — clearing the owner must reach the service as null', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });
    await assignMaintenanceOwner('req-1', null);
    const call = apiMock.api.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(call.body).toHaveProperty('userId');
    expect(call.body.userId).toBeNull();
    expect(call.body).toEqual({ userId: null });
  });
});

describe('listMaintenanceNotes', () => {
  it('GETs the notes route and unwraps the { notes } envelope — literal path pin', async () => {
    const notes = [
      { id: 'note-1', authorUserId: 'user-1', body: 'Called the vendor.', createdAt: '2026-08-05T00:00:00.000Z' },
    ];
    apiMock.api.mockResolvedValueOnce({ notes });
    await expect(listMaintenanceNotes('req-1')).resolves.toEqual(notes);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/notes');
  });
});

describe('addMaintenanceNote', () => {
  it('POSTs { body } to the notes route — literal path + body pin', async () => {
    apiMock.api.mockResolvedValueOnce({ id: 'note-1' });
    await expect(addMaintenanceNote('req-1', 'Called the vendor.')).resolves.toEqual({ id: 'note-1' });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/req-1/notes', {
      method: 'POST',
      body: { body: 'Called the vendor.' },
    });
  });
});

describe('listMaintenanceMembers', () => {
  it('GETs the (static) members route and unwraps the { members } envelope — literal path pin', async () => {
    const members = [{ userId: 'user-1', name: 'Dana Keeler' }];
    apiMock.api.mockResolvedValueOnce({ members });
    await expect(listMaintenanceMembers()).resolves.toEqual(members);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/maintenance-requests/members');
  });
});

/**
 * WIRING PINS for app/(drawer)/maintenance.tsx. That screen imports native
 * modules (expo-router, react-native) at top level, so the vitest config
 * excludes app/ from compilation (see vitest.config.ts); these source-level
 * assertions pin the load-bearing rules a fresh edit could silently drop —
 * same idiom as item-create.test.ts's "app/item/new.tsx is wired to the
 * shared create path" block.
 *
 * HONEST LIMITS OF THIS TECHNIQUE (read before touching this file again):
 * these are TEXT assertions over a source string — `readFileSync` + string/
 * regex matching, nothing executes. That means they DO catch: the literal
 * words/vocabulary this feature depends on going missing (a banned phrase
 * creeping in, a note's wording drifting from the brief), and a symbol being
 * deleted outright (an import, a call, a permission key disappearing from
 * the file). It does NOT prove the code actually RUNS the way the pin
 * implies at runtime — a value can satisfy every regex here while being
 * completely disconnected from the variable that controls rendering or
 * gating (dead code sitting next to a hardcoded replacement), and a `return`
 * can vanish from inside a matched `if` block undetected UNLESS a pin
 * specifically opens that block and looks. Every pin below that claims to
 * verify a GATE (not just presence of a phrase) opens the actual assignment
 * or block body and checks its contents, rather than checking that two
 * unrelated substrings both merely occur somewhere in the file. A future
 * pin added here must do the same, or it is decoration, not a test.
 */
describe('app/(drawer)/maintenance.tsx is wired to the module gate + accurate language', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/(drawer)/maintenance.tsx'),
    'utf8',
  );

  it('`enabled` is actually ASSIGNED FROM the shared module registry, not left dangling next to a hardcoded value', () => {
    // Checking `useEnabledModules` and `.has('maintenance_requests')` are
    // both present anywhere in the file is not enough: a mutation can leave
    // `enabledModules.has('maintenance_requests');` sitting in the file as a
    // dead, unassigned expression and hardcode `const enabled = true;` right
    // next to it — every substring check above still passes. This pin
    // requires the `.has(...)` call to be the right-hand side of the
    // `enabled` assignment itself.
    expect(src).toContain('useEnabledModules');
    expect(src).toMatch(
      /const\s+enabled\s*=\s*enabledModules\.has\(\s*['"]maintenance_requests['"]\s*\)\s*;/,
    );
  });

  it('the module-off branch renders BEFORE the list ever loads, and the guard actually RETURNS (unreachable + invisible when off)', () => {
    // Two separate ways this can look fixed while being broken:
    //  1. the `if (!enabled)` text exists somewhere before the call site but
    //     isn't really guarding it (checked via index comparison, as before);
    //  2. the `if (!enabled) { ... }` block exists in the right place but its
    //     `return;` has been stripped, leaving the guard clear the loading
    //     spinner and fall through into the fetch anyway — a disabled org
    //     would then silently fire the request, contradicting this file's
    //     own "Invisible when off" comment. Pass #1 alone cannot catch this:
    //     it only ever checked that the `if (...)` TEXT preceded the call,
    //     never that a `return` sat inside it. This pin opens the block body
    //     and requires an actual `return;` inside it, then checks THAT
    //     return's own position — not the `if`'s — against the call site.
    const callSite = src.indexOf('await listMaintenanceRequests(');
    expect(callSite).toBeGreaterThan(-1);

    const guardMatch = src.match(/if\s*\(\s*!enabled\s*\)\s*\{([\s\S]*?)\}/);
    expect(guardMatch).not.toBeNull();
    const guardBody = guardMatch![1];
    expect(guardBody).toContain('return;');

    const returnOffset = guardMatch!.index! + guardMatch![0].indexOf('return;');
    expect(returnOffset).toBeGreaterThan(-1);
    expect(returnOffset).toBeLessThan(callSite);
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

  it('`canReadAll` is actually ASSIGNED FROM showWriteCta(read_all/manage), not left dangling next to a hardcoded value', () => {
    // Same class of gap as the `enabled` pin above: a mutation can leave both
    // showWriteCta(...) calls sitting in the file as dead, unassigned
    // expressions and hardcode `const canReadAll = true;` beside them — a
    // pin that only checks the permission strings occur SOMEWHERE in the
    // file cannot tell the difference. This requires `canReadAll` to be
    // assigned directly from the `||` of both calls.
    expect(src).toMatch(
      /const\s+canReadAll\s*=\s*showWriteCta\(\s*perms\s*,\s*['"]maintenance_requests:read_all['"]\s*\)\s*\|\|\s*showWriteCta\(\s*perms\s*,\s*['"]maintenance_requests:manage['"]\s*\)\s*;/,
    );
  });

  it('`canSubmit` is actually ASSIGNED FROM showWriteCta(submit), not left dangling next to a hardcoded value', () => {
    // The New-request affordance and the search box's scope='all' branch
    // both key off canSubmit/canReadAll — the same dead-code-plus-hardcode
    // gap applies here too, so it gets the same assignment-shape pin rather
    // than a bare substring check.
    expect(src).toMatch(
      /const\s+canSubmit\s*=\s*showWriteCta\(\s*perms\s*,\s*['"]maintenance_requests:submit['"]\s*\)\s*;/,
    );
  });

  it('derives status labels from MAINTENANCE_STATUS_LABELS, never a hand-copied literal', () => {
    expect(src).toContain('MAINTENANCE_STATUS_LABELS');
  });

  it('formats the request handle through the shared formatter, never a raw number', () => {
    expect(src).toContain('formatMaintenanceRequestNumber');
  });

  it('(Task 9) `status` is actually DERIVED FROM statusQueryParam(statusLabel), not left dangling next to a hardcoded value', () => {
    expect(src).toContain('MAINTENANCE_STATUS_CHIPS');
    expect(src).toMatch(/const\s+status\s*=\s*statusQueryParam\(\s*statusLabel\s*\)\s*;/);
  });

  it('(Task 9) the status chip row is rendered from MAINTENANCE_STATUS_CHIPS.map, and each chip actually calls setStatusLabel with ITS OWN label (not a hardcoded value)', () => {
    const mapMatch = src.match(/\{MAINTENANCE_STATUS_CHIPS\.map\(\(chip\) => \(([\s\S]*?)\)\)\}/);
    expect(mapMatch).not.toBeNull();
    const body = mapMatch![1];
    expect(body).toContain('setStatusLabel(chip.label)');
    expect(body).toContain('{chip.label}');
  });

  it('(Task 9) `status` is threaded into the listMaintenanceRequests call, not just computed and discarded', () => {
    const callMatch = src.match(/await listMaintenanceRequests\(\{([\s\S]*?)\}\)/);
    expect(callMatch).not.toBeNull();
    expect(callMatch![1]).toContain('status');
  });

  it('(Task 9) the row pill status is derived from the shared statusPillTone helper, never a hand-copied Record', () => {
    expect(src).not.toContain('STATUS_PILL');
    expect(src).toMatch(/const\s+pillStatus\s*=\s*statusPillTone\(\s*row\.status\s*\)\s*;/);
  });
});

/**
 * WIRING PIN for app/maintenance/new.tsx charters picker. Mobile's site picker
 * must match web's active-only filter (ChartersService.list() defaults to
 * active-only; RLS is org-scoped, not status-scoped, so archived charters
 * would otherwise appear in the mobile picker even though web hides them).
 *
 * HONEST LIMITS: this pin checks that the literal query predicate text is
 * present in the source file — it catches the filter going missing entirely,
 * but does NOT prove the filter actually executes as intended at runtime,
 * nor does it catch the filter being placed inside a dead-code branch or
 * unreachable conditional. A stronger test would extract the charters query
 * into a testable helper (see debounced-list-load.ts precedent), but for a
 * single query in one place, a source-level text assertion suffices to catch
 * the common mutation: a future edit that removes the filter line entirely
 * (e.g., a merge conflict resolution or refactoring that accidentally drops
 * it). Verify runtime behavior by hand-testing the mobile site picker in
 * a staging org with archived sites present.
 */
describe('app/maintenance/new.tsx charters picker hides archived sites', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/maintenance/new.tsx'),
    'utf8',
  );

  it('queries charters with .eq(\'status\', \'active\') to match web behavior', () => {
    // The charters query must include the active-only filter. This regex
    // matches the specific pattern: .eq('status', 'active') with flexible
    // whitespace and quote styles.
    expect(src).toMatch(
      /\.eq\(\s*['"]status['"]\s*,\s*['"]active['"]\s*\)/,
    );
  });

  it('places the status filter after the organization_id filter in the query chain', () => {
    // Weak (text-only) check that the filters appear in the right order:
    // organization_id filter must come before status filter. This cannot
    // catch dead code or reordering within a different query chain, but it
    // does catch a simple copy-paste where someone moved the status filter
    // below the order() call, which would break the query.
    const orgIdIndex = src.indexOf(`.eq('organization_id', orgId)`);
    const statusIndex = src.indexOf(`.eq('status', 'active')`);
    expect(orgIdIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(-1);
    expect(orgIdIndex).toBeLessThan(statusIndex);
  });
});

/**
 * WIRING PINS for app/maintenance/[id].tsx (Task 20). Every DECISION this
 * screen makes — transport selection, the R3 record-after-open ordering,
 * the duplicate-draft gate, the condensed-notice gate — is delegated to
 * `@/lib/maintenance-email-actions` and proven BEHAVIORALLY there
 * (maintenance-email-actions.test.ts). What is left here is real, but
 * narrower: that the screen actually WIRES those tested helpers in rather
 * than reimplementing the decision inline or dropping the wiring. Same
 * HONEST LIMITS as every other pin in this file — text assertions only,
 * nothing executes; verify runtime behavior by hand-testing the detail
 * screen in a staging org (open/reopen a draft, a condensed request, an
 * oversized one).
 */
describe('app/maintenance/[id].tsx is wired to the tested email-action helpers + accurate language', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/maintenance/[id].tsx'), 'utf8');

  it('`enabled` is actually ASSIGNED FROM the shared module registry, not left dangling next to a hardcoded value', () => {
    expect(src).toContain('useEnabledModules');
    expect(src).toMatch(
      /const\s+enabled\s*=\s*enabledModules\.has\(\s*['"]maintenance_requests['"]\s*\)\s*;/,
    );
  });

  it('the load effect actually RETURNS when the module is off (or there is no id), before ever calling getMaintenanceRequest', () => {
    const callSite = src.indexOf('await getMaintenanceRequest(');
    expect(callSite).toBeGreaterThan(-1);
    const guardMatch = src.match(/if\s*\(\s*!enabled\s*\|\|\s*!id\s*\)\s*\{([\s\S]*?)\}/);
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![1]).toContain('return;');
    const returnOffset = guardMatch!.index! + guardMatch![0].indexOf('return;');
    expect(returnOffset).toBeLessThan(callSite);
  });

  it('the module-off render path actually RETURNS a gate screen before the loading/detail branches, and never claims an outcome', () => {
    const offBranch = src.match(/if\s*\(\s*!enabled\s*\)\s*\{([\s\S]*?)\n\s{2}\}/);
    expect(offBranch).not.toBeNull();
    expect(offBranch![1]).toContain('return');
    expect(offBranch![1]).toContain('GateScreen');
  });

  it('`handleOpenPress` gates the duplicate-draft Alert.alert on `shouldConfirmBeforeOpening(openCount)`, offers Cancel / Open Another Draft, and the confirm button actually calls runOpen (not a no-op)', () => {
    const fnMatch = src.match(/function handleOpenPress\(transport: EmailTransport\) \{([\s\S]*?)\n {2}\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];
    expect(body).toContain('shouldConfirmBeforeOpening(openCount)');
    expect(body).toContain("Alert.alert('Open another draft?', DUPLICATE_WARNING,");
    expect(body).toContain("{ text: 'Cancel', style: 'cancel' }");
    expect(body).toContain("{ text: 'Open Another Draft', onPress: () => void runOpen(transport) }");
    // Not just present anywhere — this is the FIRST-open (no confirm) path,
    // must still exist and must still call the same runOpen.
    expect(body).toContain('void runOpen(transport);');
  });

  it('`runOpen` passes `recordDraftOpened` ONLY inside the onOpened callback given to `openMaintenanceDraft` — never called unconditionally, never before the open resolves', () => {
    const fnMatch = src.match(/async function runOpen\(transport: EmailTransport\) \{([\s\S]*?)\n {2}\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];
    // The call gained a `platform` argument when the native ms-outlook
    // transport landed — pinned here too, because a screen that stopped
    // passing it would silently lose the per-platform cc-trust decision.
    const openCallIdx = body.indexOf(
      'const result = await openMaintenanceDraft(transport, prepared, platform, () => {',
    );
    const recordIdx = body.indexOf('void recordDraftOpened(id)');
    const setBusyFalseIdx = body.indexOf('setBusy(false);');
    expect(openCallIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(openCallIdx);
    expect(setBusyFalseIdx).toBeGreaterThan(recordIdx);
  });

  it('the screen reports the transport that ACTUALLY opened — the success card renders successMessageFor(lastResult.used), never a hardcoded Outlook claim', () => {
    // A fallback to the default mail app must not print "Outlook opened".
    expect(src).toContain('{successMessageFor(lastResult.used)}');
    expect(src).not.toMatch(/\{SUCCESS_MESSAGE\}/);
    // Platform.OS is read at the screen (react-native cannot be imported in
    // this repo's node-environment vitest) and handed to the pure decision:
    expect(src).toMatch(
      /const platform: OutlookPlatform = Platform\.OS === 'android' \? 'android' : 'ios';/,
    );
  });

  it('neither email button renders when `prepared.linkFits` is false — the oversized state is copy-only', () => {
    expect(src).toMatch(/\{prepared\.linkFits \? \(\s*<Button[\s\S]{0,400}Open in Outlook/);
    expect(src).toMatch(/\{prepared\.linkFits \? \(\s*<Button[\s\S]{0,400}Open in Default Email App/);
    expect(src).toMatch(/\{!prepared\.linkFits \? \(\s*<Card[\s\S]{0,150}OVERSIZED_MESSAGE/);
  });

  it('the condensed notice is gated by the tested `shouldShowCondensedNotice` helper, actually assigned to a variable used in the render', () => {
    expect(src).toMatch(/const\s+showCondensedNotice\s*=\s*shouldShowCondensedNotice\(prepared\)\s*;/);
    expect(src).toMatch(/\{showCondensedNotice \? \(/);
  });

  it('the copy fallback is a SELECTABLE, non-editable TextInput (audit Q9 — no clipboard module in the binary)', () => {
    expect(src).toMatch(
      /<TextInput\s+multiline\s+editable=\{false\}\s+selectTextOnFocus\s+value=\{prepared\.clipboardText\}/,
    );
    // The literal "Press and hold..." copy lives in maintenance-email-
    // actions.ts's COPY_HELPER_TEXT export (own test: exported copy is the
    // literal, brief-pinned text) — this screen must render THAT constant,
    // never a re-typed inline copy that could drift from it.
    expect(src).toContain('{COPY_HELPER_TEXT}');
  });

  it('the blocked-state retry line renders the shared BLOCKED_RETRY_MESSAGE constant, never a re-typed inline literal (fast-follow fix, 2026-08-06)', () => {
    // Wired to the shared constant — not hand-copied inline, so screen and
    // maintenance-email-actions.test.ts's literal pin cannot drift apart.
    expect(src).toContain('{BLOCKED_RETRY_MESSAGE}');
    // Source-pin regression guard: the ORIGINAL bug was a hardcoded literal
    // here claiming Copy Email Details renders "below" this message, when
    // the button actually renders above it. Never reintroduce that literal.
    expect(src).not.toMatch(/Copy Email Details below/);
  });

  it('renders the detail-page StockPilot-activity note (web page.tsx\'s own verbatim sentence) — no fake ticket-conversation timeline', () => {
    expect(src).toContain(
      'Local StockPilot actions only. Ticket replies happen in the Outlook/Zendesk email conversation and are not shown here.',
    );
  });

  it('never renders forbidden vocabulary implying an outcome StockPilot cannot observe (brief section 20; §GC-4 extended for Task 10\'s CLOSE-OUT card)', () => {
    const FORBIDDEN = [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
      // §GC-4 additions (Maintenance Resolved plan) — this surface gains
      // them because Task 10 modifies this file to add the CLOSE-OUT card.
      'Ticket closed',
      'Ticket resolved',
      'Zendesk ticket closed',
      'Zendesk ticket updated',
      'Zendesk ticket resolved',
      'Issue verified fixed',
    ];
    for (const banned of FORBIDDEN) {
      expect(src).not.toContain(banned);
    }
  });

  it('derives status labels from MAINTENANCE_STATUS_LABELS, never a hand-copied literal', () => {
    expect(src).toContain('MAINTENANCE_STATUS_LABELS');
  });

  it('(Task 9) the header pill status is derived from the shared statusPillTone helper, never a hand-copied Record', () => {
    expect(src).not.toContain('STATUS_PILL');
    expect(src).toMatch(/const\s+pillStatus\s*=\s*statusPillTone\(\s*detail\.status\s*\)\s*;/);
  });

  it('(Task 9) `showResolutionCard` is actually ASSIGNED FROM shouldShowResolutionCard(detail), not left dangling next to a hardcoded value', () => {
    expect(src).toMatch(
      /const\s+showResolutionCard\s*=\s*shouldShowResolutionCard\(\s*detail\s*\)\s*;/,
    );
  });

  it('(Task 9) the Resolution card is gated on `showResolutionCard` and renders the note + resolver-name line', () => {
    const gateIdx = src.indexOf('{showResolutionCard ? (');
    expect(gateIdx).toBeGreaterThan(-1);
    const cardEndIdx = src.indexOf(') : null}', gateIdx);
    expect(cardEndIdx).toBeGreaterThan(gateIdx);
    const cardBody = src.slice(gateIdx, cardEndIdx);
    expect(cardBody).toContain('RESOLUTION');
    expect(cardBody).toContain('{detail.resolutionNote}');
    expect(cardBody).toContain('Marked resolved by ${detail.resolvedByName}');
  });

  it('(Task 9) `requesterPhotos`/`resolutionPhotos` are actually DESTRUCTURED FROM splitPhotosByKind(photos), not left dangling next to the raw `photos` array', () => {
    expect(src).toMatch(
      /const\s*\{\s*requester:\s*requesterPhotos\s*,\s*resolution:\s*resolutionPhotos\s*\}\s*=\s*splitPhotosByKind\(\s*photos\s*\)\s*;/,
    );
  });

  it('(Task 9) the PHOTOS card maps ONLY requesterPhotos — never the raw `photos` array or resolutionPhotos', () => {
    // Anchor re-pinned when the card gained its add-photo affordance: the
    // eyebrow now runs the tested `requestPhotosHeading` helper (which adds
    // web's `n/MAINTENANCE_MAX_PHOTOS` counter) instead of interpolating the
    // count inline. Every assertion below is unchanged — this still requires
    // that the array feeding the eyebrow AND the very next `.map((p) =>`
    // after it are both `requesterPhotos`.
    const eyebrowIdx = src.indexOf('requestPhotosHeading(requesterPhotos.length)');
    expect(eyebrowIdx).toBeGreaterThan(-1);
    const mapIdx = src.indexOf('requesterPhotos.map((p) =>', eyebrowIdx);
    expect(mapIdx).toBeGreaterThan(eyebrowIdx);
    // The mutation this catches: swapping requesterPhotos.map for
    // photos.map or resolutionPhotos.map right after the PHOTOS eyebrow —
    // the very next `.map((p) =>` call after this eyebrow must belong to
    // requesterPhotos, not some other array.
    const nextMapIdx = src.indexOf('.map((p) =>', eyebrowIdx);
    expect(src.slice(nextMapIdx - 'requesterPhotos'.length, nextMapIdx)).toBe('requesterPhotos');
  });

  it('(Task 9) the RESOLUTION PROOF card is gated on resolutionPhotos.length and maps ONLY resolutionPhotos, distinctly labeled from the requester PHOTOS card', () => {
    const eyebrowIdx = src.indexOf('`RESOLUTION PROOF · ${resolutionPhotos.length}`');
    expect(eyebrowIdx).toBeGreaterThan(-1);
    const gateIdx = src.lastIndexOf('{resolutionPhotos.length > 0 ? (', eyebrowIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    const mapIdx = src.indexOf('.map((p) =>', eyebrowIdx);
    expect(src.slice(mapIdx - 'resolutionPhotos'.length, mapIdx)).toBe('resolutionPhotos');
  });

  /**
   * (Task 10) CLOSE-OUT card wiring pins. Every DECISION the card makes —
   * which actions are visible, whether the resolve confirm button is
   * enabled, which literal `kind` a proof-photo upload carries — is
   * delegated to a tested pure helper (maintenance-actions.test.ts,
   * maintenance-upload.test.ts's kind-threading block) and proven
   * BEHAVIORALLY there. What is left here is narrower: that the screen
   * actually WIRES those tested helpers in, rather than reimplementing the
   * decision inline or silently dropping the wiring. Same HONEST LIMITS as
   * every other pin in this file (see the block comment above the
   * app/(drawer)/maintenance.tsx describe above) — text assertions only,
   * nothing executes; this cannot prove the resolve/archive/assign/notes
   * network calls actually reach the server correctly at runtime, only
   * that the source wires the right tested function to the right button.
   * Verify runtime behavior by hand-testing the CLOSE-OUT card in a
   * staging org (resolve with/without a proof photo, archive, assign and
   * clear an owner, add an internal note).
   */
  it('(Task 10) `actions` is actually ASSIGNED FROM availableCloseoutActions(...), not left dangling next to a hardcoded value, and `showCloseout` is derived from it', () => {
    expect(src).toMatch(
      /const\s+actions\s*=\s*availableCloseoutActions\(\{[\s\S]{0,200}?\}\)\s*;/,
    );
    expect(src).toMatch(
      /const\s+showCloseout\s*=\s*actions\.resolve\s*\|\|\s*actions\.archive\s*\|\|\s*actions\.assignOwner\s*\|\|\s*actions\.notes\s*;/,
    );
    // The CLOSE-OUT Card itself is gated on that derived value, not a
    // hardcoded `true`/always-rendered Card.
    expect(src).toContain('{showCloseout ? (');
  });

  it('(Task 10) the Resolve confirm button is disabled by the TESTED canConfirmResolve(...) gate, never a hand-rolled length check', () => {
    expect(src).toMatch(
      /disabled=\{!canConfirmResolve\(resolveNote\)\s*\|\|\s*resolvePending\}/,
    );
  });

  it('(Task 10) the CLOSE-OUT card renders each action behind its OWN availableCloseoutActions flag — resolve/archive/assignOwner/notes are not conflated', () => {
    expect(src).toContain('{actions.resolve ? (');
    expect(src).toContain('{actions.archive ? (');
    expect(src).toContain('{actions.assignOwner ? (');
    expect(src).toContain('{actions.notes ? (');
  });

  /**
   * REWRITTEN (reason): this asserted `toContain("{ kind: 'resolution' }")`,
   * which was FALSE ASSURANCE — proven, not suspected. A verifier flipped the
   * REQUEST queue's kind from 'requester' to 'resolution'; the screen then held
   * TWO 'resolution' literals and ZERO 'requester' ones, and this pin still
   * passed while all 1345 mobile tests stayed green. A source-text grep cannot
   * tell which queue a literal belongs to, and cannot fail when one queue
   * silently becomes the other.
   *
   * The value now lives behind a seam the harness can execute
   * (requestPhotoUploadOptions / resolutionPhotoUploadOptions), and
   * maintenance-request-photos.test.ts asserts what each RETURNS — mutation-
   * proven: flipping the request kind fails two tests there. What remains for
   * THIS source-level test is the half a value assertion cannot reach: that the
   * screen delegates to that seam at all, rather than re-typing a literal that
   * could drift away from the tested value.
   */
  it('(Task 10) both photo queues delegate to the tested upload-options seam — neither re-types a kind literal that could drift', () => {
    expect(src).toContain('requestPhotoUploadOptions()');
    expect(src).toContain('resolutionPhotoUploadOptions()');
    // No inline kind literal may survive in the screen: one would be
    // unreachable by the module tests and free to diverge from them.
    expect(src).not.toContain("{ kind: 'resolution' }");
    expect(src).not.toContain("{ kind: 'requester' }");
  });

  it('(Task 10) MOBILE_RESOLVE_DISCLOSURE (not a re-typed inline literal) is rendered inside the Resolve section', () => {
    expect(src).toContain('{MOBILE_RESOLVE_DISCLOSURE}');
  });

  it('(Task 10) a successful resolve/archive/assign bumps refreshKey via refreshDetail() — never a local hand-patched echo of server state', () => {
    expect(src).toMatch(/function refreshDetail\(\)\s*\{\s*setRefreshKey\(\(k\) => k \+ 1\);\s*\}/);
    // Every write action's success path calls it.
    const doResolveBody = src.slice(
      src.indexOf('async function doResolve()'),
      src.indexOf('\n  }', src.indexOf('async function doResolve()')),
    );
    expect(doResolveBody).toContain('refreshDetail();');
    const doArchiveBody = src.slice(
      src.indexOf('async function doArchive()'),
      src.indexOf('\n  }', src.indexOf('async function doArchive()')),
    );
    expect(doArchiveBody).toContain('refreshDetail();');
    const doAssignBody = src.slice(
      src.indexOf('async function doAssign('),
      src.indexOf('\n  }', src.indexOf('async function doAssign(')),
    );
    expect(doAssignBody).toContain('refreshDetail();');
  });

  it('(Task 10) the resolve error path stays open and preserves input — resolveOpen/resolveNote are never cleared in the catch branch', () => {
    const doResolveMatch = src.match(/async function doResolve\(\) \{([\s\S]*?)\n {2}\}/);
    expect(doResolveMatch).not.toBeNull();
    const body = doResolveMatch![1];
    const tryIdx = body.indexOf('try {');
    const catchIdx = body.indexOf('} catch (e) {');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    const tryBlock = body.slice(tryIdx, catchIdx);
    const catchBlock = body.slice(catchIdx);
    // Success path (inside try) is the ONLY place that closes the section
    // and clears the note — never inside the catch block.
    expect(tryBlock).toContain('setResolveOpen(false)');
    expect(tryBlock).toContain("setResolveNote('')");
    expect(catchBlock).not.toContain('setResolveOpen(false)');
    expect(catchBlock).not.toContain("setResolveNote('')");
    expect(catchBlock).toContain('setResolveError(mapActionError(e, RESOLVE_GENERIC_ERROR))');
  });
});

/**
 * WIRING PINS for the "Report a problem" launch points (Task 20). Both
 * mirror web's `ReportProblemButton` gate exactly (moduleEnabled &&
 * canSubmit) — a viewer who cannot submit must never see a button that only
 * dead-ends on the destination screen's own re-gate, and an org with the
 * module off must never see a dead affordance either.
 */
describe('scan.tsx "Report a problem" launch point', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/(drawer)/(tabs)/scan.tsx'),
    'utf8',
  );

  it('`canReportProblem` is actually ASSIGNED FROM module-enabled AND submit-permission, not left dangling next to a hardcoded value', () => {
    expect(src).toMatch(
      /const\s+maintenanceEnabled\s*=\s*enabledModules\.has\(\s*['"]maintenance_requests['"]\s*\)\s*;/,
    );
    expect(src).toMatch(
      /const\s+canReportProblem\s*=\s*\n\s*maintenanceEnabled\s*&&\s*showWriteCta\(permissions,\s*['"]maintenance_requests:submit['"]\s*\)\s*;/,
    );
  });

  it('the button only renders behind `canReportProblem`, and pushes to /maintenance/new with the scanned item id — never sku/name (server re-derives, binding constraint 6)', () => {
    const gateIdx = src.indexOf('{canReportProblem ? (');
    expect(gateIdx).toBeGreaterThan(-1);
    const pathnameIdx = src.indexOf("pathname: '/maintenance/new'", gateIdx);
    const paramsIdx = src.indexOf('params: { itemId: item.id }', gateIdx);
    expect(pathnameIdx).toBeGreaterThan(gateIdx);
    expect(paramsIdx).toBeGreaterThan(pathnameIdx);
  });
});

describe('item/[id].tsx "Report a problem" launch point', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');

  it('`canReportProblem` is actually ASSIGNED FROM module-enabled AND submit-permission, not left dangling next to a hardcoded value', () => {
    expect(src).toMatch(
      /const\s+canReportProblem\s*=\s*\n\s*enabledModules\.has\(\s*['"]maintenance_requests['"]\s*\)\s*&&\s*\n\s*showWriteCta\(permissions,\s*['"]maintenance_requests:submit['"]\s*\)\s*;/,
    );
  });

  it('the button only renders behind `canReportProblem`, and pushes to /maintenance/new with THIS item\'s id — never sku/name (server re-derives, binding constraint 6)', () => {
    const gateIdx = src.indexOf('{canReportProblem ? (');
    expect(gateIdx).toBeGreaterThan(-1);
    const pathnameIdx = src.indexOf("pathname: '/maintenance/new'", gateIdx);
    const paramsIdx = src.indexOf('params: { itemId: item.id }', gateIdx);
    expect(pathnameIdx).toBeGreaterThan(gateIdx);
    expect(paramsIdx).toBeGreaterThan(pathnameIdx);
  });
});
