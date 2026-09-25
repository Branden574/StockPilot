import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeGateFromMe,
  CloseGateResponseError,
  COUNT_POST_CHECKING_COPY,
  COUNT_POST_UNKNOWN_COPY,
  COUNT_POST_UNKNOWN_OFFLINE_COPY,
  countFooter,
  fetchCountCloseGate,
  forgetCloseGates,
  rememberedCloseGate,
  type CloseGateState,
} from './count-close-gate';

/**
 * The phone's Post gate (F1-2). Staff can count but not post: the screen
 * showed them Post anyway, and the post refused them. These pin:
 *   - the gate is core cycleCountCloseGate fed the role AND the effective
 *     permissions from /api/v1/me/permissions;
 *   - Post appears only on a known yes; a known no says who posts; before an
 *     answer the footer says so (never a guess either way);
 *   - the answer is remembered per account and workspace, in memory.
 */

const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
  forgetCloseGates();
});

const BOTH = ['stock:adjust', 'cycle_counts:assign', 'items:read'];

describe('closeGateFromMe', () => {
  it('a manager with stock:adjust can post; cancel also needs cycle_counts:assign', () => {
    expect(closeGateFromMe({ role: 'manager', permissions: BOTH })).toEqual({ canPost: true, canCancel: true });
    expect(closeGateFromMe({ role: 'manager', permissions: ['stock:adjust'] })).toEqual({ canPost: true, canCancel: false });
  });

  // Mutation caught: gating on stock:adjust only.
  it('staff with stock:adjust (even with cycle_counts:assign by override) cannot', () => {
    expect(closeGateFromMe({ role: 'staff', permissions: ['stock:adjust'] })).toEqual({ canPost: false, canCancel: false });
    expect(closeGateFromMe({ role: 'staff', permissions: BOTH })).toEqual({ canPost: false, canCancel: false });
  });

  it('a manager whose stock:adjust was revoked cannot', () => {
    expect(closeGateFromMe({ role: 'admin', permissions: ['cycle_counts:assign'] })).toEqual({ canPost: false, canCancel: false });
  });

  it('an answer without a known role or a permission list is a failure, not a no', () => {
    expect(() => closeGateFromMe({ role: 'superuser', permissions: BOTH })).toThrow(CloseGateResponseError);
    expect(() => closeGateFromMe({ role: 'manager' })).toThrow(CloseGateResponseError);
    expect(() => closeGateFromMe('<html>')).toThrow(CloseGateResponseError);
  });
});

describe('fetchCountCloseGate / rememberedCloseGate', () => {
  it('reads /api/v1/me/permissions and remembers the answer for this account and workspace', async () => {
    apiMock.api.mockResolvedValueOnce({ role: 'manager', permissions: BOTH });
    await expect(fetchCountCloseGate('u1', 'org-1')).resolves.toEqual({ canPost: true, canCancel: true });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/me/permissions');
    expect(rememberedCloseGate('u1', 'org-1')).toEqual({ canPost: true, canCancel: true });
    expect(rememberedCloseGate('u2', 'org-1')).toBeNull();
    expect(rememberedCloseGate('u1', 'org-2')).toBeNull();
  });

  it('a failed read throws and remembers nothing', async () => {
    apiMock.api.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(fetchCountCloseGate('u1', 'org-1')).rejects.toThrow('boom');
    expect(rememberedCloseGate('u1', 'org-1')).toBeNull();
  });
});

describe('countFooter', () => {
  const base = { posting: false, offline: false, hasPending: false, countedCount: 1, total: 2 };
  const yes: CloseGateState = { kind: 'known', gate: { canPost: true, canCancel: true } };
  const no: CloseGateState = { kind: 'known', gate: { canPost: false, canCancel: false } };

  it('a known yes: the Post button, worded and disabled as before', () => {
    expect(countFooter({ ...base, gate: yes })).toEqual({
      kind: 'post',
      label: 'Post (1/2 counted)',
      disabled: false,
      partial: true,
    });
    expect(countFooter({ ...base, gate: yes, countedCount: 2 })).toMatchObject({ label: 'Post cycle count', partial: false });
    expect(countFooter({ ...base, gate: yes, offline: true })).toMatchObject({ label: 'Reconnect to post', disabled: true });
    expect(countFooter({ ...base, gate: yes, hasPending: true })).toMatchObject({
      label: 'Sync pending edits to post',
      disabled: true,
    });
    expect(countFooter({ ...base, gate: yes, countedCount: 0 })).toMatchObject({ disabled: true });
    expect(countFooter({ ...base, gate: yes, posting: true })).toMatchObject({ label: 'Posting…', disabled: true });
  });

  // Mutation caught: the footer falling back to Post for anyone who can count.
  it('a known no: who posts, and no button', () => {
    expect(countFooter({ ...base, gate: no })).toEqual({
      kind: 'manager_posts',
      text: 'A manager reviews and posts this count.',
    });
  });

  it('before an answer it says so, and never offers Post', () => {
    expect(countFooter({ ...base, gate: { kind: 'loading' } })).toEqual({ kind: 'checking', text: COUNT_POST_CHECKING_COPY });
    expect(countFooter({ ...base, gate: { kind: 'unknown', offline: true } })).toEqual({
      kind: 'unknown',
      text: COUNT_POST_UNKNOWN_OFFLINE_COPY,
      retry: false,
    });
    expect(COUNT_POST_UNKNOWN_OFFLINE_COPY).toBe('Posting needs a connection. A manager reviews and posts this count.');
    expect(countFooter({ ...base, gate: { kind: 'unknown', offline: false } })).toEqual({
      kind: 'unknown',
      text: COUNT_POST_UNKNOWN_COPY,
      retry: true,
    });
  });
});
