import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks declared before the module under test is imported ──────────────────

const mockOpenAuthSessionAsync = vi.fn();

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSessionAsync(...args),
}));

const mockApi = vi.fn();
vi.mock('./api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { connectZendesk } from './zendesk-oauth';

// ── Helpers ───────────────────────────────────────────────────────────────────
const AUTHORIZE_URL = 'https://accounts.zendesk.com/oauth/authorizations/new?foo=bar';
const REDIRECT_PREFIX = 'stockpilot://zendesk';

beforeEach(() => {
  vi.resetAllMocks();
  // Default: api returns an authorizeUrl
  mockApi.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('connectZendesk()', () => {
  it('calls api with the connect-url path', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'stockpilot://zendesk/connected',
    });
    await connectZendesk();
    expect(mockApi).toHaveBeenCalledWith('/api/v1/zendesk/me/connect-url');
  });

  it('calls WebBrowser.openAuthSessionAsync with the authorizeUrl and redirect prefix', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'stockpilot://zendesk/connected',
    });
    await connectZendesk();
    expect(mockOpenAuthSessionAsync).toHaveBeenCalledWith(AUTHORIZE_URL, REDIRECT_PREFIX);
  });

  it('returns { ok: true } when result type is success and url contains /connected', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'stockpilot://zendesk/connected',
    });
    const result = await connectZendesk();
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: false, reason: "failed" } when result type is success but url contains /error', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'stockpilot://zendesk/error',
    });
    const result = await connectZendesk();
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  it('returns { ok: false, reason: "cancelled" } when result type is cancel', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const result = await connectZendesk();
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('returns { ok: false, reason: "cancelled" } when result type is dismiss', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });
    const result = await connectZendesk();
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('returns { ok: false, reason: "unavailable" } when openAuthSessionAsync throws', async () => {
    mockOpenAuthSessionAsync.mockRejectedValue(new Error('Native module not available'));
    const result = await connectZendesk();
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns { ok: false, reason: "unavailable" } when api() throws', async () => {
    mockApi.mockRejectedValue(new Error('Network error'));
    const result = await connectZendesk();
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('never throws — always resolves', async () => {
    mockApi.mockRejectedValue(new TypeError('Catastrophic'));
    await expect(connectZendesk()).resolves.toBeDefined();
  });
});
