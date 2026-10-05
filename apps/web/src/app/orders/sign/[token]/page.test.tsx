import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/token-hash';
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Migrations 0389 and 0392: the public sign page resolves a token exactly as
 * the POST route does (server/lib/order-secrets). A raw token (a QR or the
 * panel's link, including one printed before 0389, whose column 0392 hashed
 * in place) opens it with no session. The
 * DIGEST every member reads opens it only for a signed-in member of the
 * order's organization, verified locally WITHOUT refreshing the session (R1:
 * this page cannot persist a refresh; an expired token is no session). Who
 * may then hand the order over is the POST route's decision. Every refusal is
 * the page's one not-found, the same as an unknown token.
 */

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('NEXT_NOT_FOUND');
  },
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

const verifiedSessionUserIdWithoutRefresh = vi.fn(async (): Promise<string | null> => null);
const isActiveOrgMember = vi.fn(async (_a: unknown, _org: string, _user: string) => false);
vi.mock('@/server/lib/sign-page-session', () => ({
  verifiedSessionUserIdWithoutRefresh: () => verifiedSessionUserIdWithoutRefresh(),
  isActiveOrgMember: (a: unknown, org: string, user: string) => isActiveOrgMember(a, org, user),
}));

vi.mock('@/components/orders/signature-collector', () => ({
  SignatureCollector: ({ token, summary }: { token: string; summary: { id: string } }) => (
    <p data-collector={token} data-order={summary.id} />
  ),
}));

import OrderSignPage from './page';

const RAW = '9d'.repeat(32);
const DIGEST = sha256Hex(RAW);
const LEGACY = '4f'.repeat(32);
const ORDER_ID = '0a000000-0000-4000-8000-000000000390';
const ORG = 'org-l4l';

function admin(column: string | null, side: string | null) {
  return makeSupabaseStub({
    'order_requests.select': servedLikePostgrest([
      {
        id: ORDER_ID,
        organization_id: ORG,
        status: 'staged_for_pickup',
        requester_name: 'Reggie',
        requester_email: 'reggie@example.com',
        requester_user_id: null,
        fulfillment_type: 'pickup',
        warehouse_id: 'wh-1',
        delivery_charter_id: null,
        signature_token_expires_at: null,
        signed_at: null,
        signature_token: column,
      },
    ]),
    'order_request_secrets.select': servedLikePostgrest(
      side === null ? [] : [{ order_request_id: ORDER_ID, signature_token: side }],
    ),
    'warehouses.select': { data: { name: 'DC4' }, error: null },
    'order_request_lines.select': { data: [], error: null },
  });
}

async function open(token: string): Promise<string> {
  const el = await OrderSignPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  vi.clearAllMocks();
  verifiedSessionUserIdWithoutRefresh.mockResolvedValue(null);
  isActiveOrgMember.mockResolvedValue(false);
  adminHolder.client = admin(DIGEST, RAW).client;
});

describe('/orders/sign/[token]', () => {
  it('the raw token of a 0389 mint opens the collector with no session (a QR, the panel link)', async () => {
    const html = await open(RAW);
    expect(html).toContain(`data-collector="${RAW}"`);
    expect(verifiedSessionUserIdWithoutRefresh).not.toHaveBeenCalled();
  });

  it('a QR printed before 0389 (its column hashed in place by 0392, no side row) opens it with no session', async () => {
    adminHolder.client = admin(sha256Hex(LEGACY), null).client;
    expect(await open(LEGACY)).toContain(`data-collector="${LEGACY}"`);
    expect(verifiedSessionUserIdWithoutRefresh).not.toHaveBeenCalled();
  });

  it('0392: a value equal to the column is a DIGEST even with no side row: no session is the one not-found', async () => {
    adminHolder.client = admin(LEGACY, null).client;
    await expect(open(LEGACY)).rejects.toBeInstanceOf(NotFound);
    expect(verifiedSessionUserIdWithoutRefresh).toHaveBeenCalledTimes(1);
  });

  it('the DIGEST with no (or an expired) session: the one not-found', async () => {
    await expect(open(DIGEST)).rejects.toBeInstanceOf(NotFound);
    expect(verifiedSessionUserIdWithoutRefresh).toHaveBeenCalledTimes(1);
  });

  it("the DIGEST with a verified session of someone who is not an accepted member of the order's organization: the one not-found", async () => {
    verifiedSessionUserIdWithoutRefresh.mockResolvedValue('outsider');
    isActiveOrgMember.mockResolvedValue(false);
    await expect(open(DIGEST)).rejects.toBeInstanceOf(NotFound);
    expect(isActiveOrgMember).toHaveBeenCalledWith(expect.anything(), ORG, 'outsider');
  });

  it("the DIGEST with a verified member's session opens the collector (the POST route decides who may hand it over)", async () => {
    verifiedSessionUserIdWithoutRefresh.mockResolvedValue('member-1');
    isActiveOrgMember.mockResolvedValue(true);
    expect(await open(DIGEST)).toContain(`data-collector="${DIGEST}"`);
  });

  it('an unknown or malformed token: the same not-found', async () => {
    await expect(open('1'.repeat(64))).rejects.toBeInstanceOf(NotFound);
    await expect(open('not-a-token')).rejects.toBeInstanceOf(NotFound);
  });
});
