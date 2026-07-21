import { describe, expect, it } from 'vitest';

import { esEmailById } from '../registry';
import { ES_MAX_HTML_BYTES } from '../tokens';
import {
  portalInviteFrom,
  renderInviteReminderEmail,
  renderPortalInviteEmail,
  renderTeamInviteEmail,
  renderWorkspaceReadyEmail,
} from './invites';

import type { RenderedEsEmail } from './security';

// Registry sample world (ES.W) adapted to real merge params.
const SEED = {
  org: 'L4L North Region',
  inviterName: 'Branden Vincent Walker',
  inviterEmail: 'branden@l4lnorth.com',
  inviteeEmail: 'theo@l4lnorth.com',
  acceptUrl: 'https://stockpilotusa.com/i/HvwVujKfQx22Chars',
  expiresOn: 'Wed, Jun 3',
  customerOrg: 'Harbor & Pine Outfitters',
  customerEmail: 'maya@harborpine.example',
  portalUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=pkce_9Zz&type=invite&next=%2Fportal',
  appUrl: 'https://stockpilotusa.com',
} as const;

const LONG_ORG = 'Pacific Intermountain Distribution & Logistics Cooperative — West';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function assertNoLeakage(res: RenderedEsEmail): void {
  for (const surface of [res.html, res.text, res.subject, res.preheader]) {
    expect(surface).not.toContain('undefined');
    expect(surface).not.toContain('{{');
    expect(surface).not.toMatch(UUID_RE);
  }
}

function assertWeight(res: RenderedEsEmail): void {
  expect(Buffer.byteLength(res.html, 'utf8')).toBeLessThanOrEqual(ES_MAX_HTML_BYTES);
}

function assertEssentialFooter(html: string): void {
  expect(html).toContain('can&rsquo;t be unsubscribed');
  expect(html).not.toContain('>Unsubscribe</a>');
  expect(html).not.toContain('Manage email preferences');
}

/** Motion=none templates must not embed a hero GIF (logo PNGs are fine). */
function assertNoMotionHero(html: string): void {
  expect(html).not.toContain('@2x.gif');
}

describe('team-invite (renderTeamInviteEmail)', () => {
  const render = () =>
    renderTeamInviteEmail({
      email: SEED.inviteeEmail,
      org: SEED.org,
      inviterName: SEED.inviterName,
      inviterEmail: SEED.inviterEmail,
      role: 'staff',
      acceptUrl: SEED.acceptUrl,
      expiresOn: SEED.expiresOn,
      window: '7 days',
      appUrl: SEED.appUrl,
    });

  it('renders with realistic seed data — workspace card, role line, help row', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('Branden invited you.');
    expect(res.html).toContain('Join L4L North Region.');
    expect(res.html).toContain('Branden Vincent Walker (branden@l4lnorth.com)');
    // ROLE_LABELS-driven role line inside the workspace card.
    expect(res.html).toContain('Warehouse User');
    expect(res.html).toContain('Manages inventory only for assigned warehouse(s).');
    // Inviter initials avatar (first + last word).
    expect(res.html).toContain('>BW</div>');
    expect(res.html).toContain('Pending · expires in 7 days');
    expect(res.html).toContain('>Accept invitation &rarr;</a>');
    expect(res.html).toContain('>What is StockPilot?</a>');
    expect(res.html).toContain('Expires Wed, Jun 3.');
    expect(res.html).toContain('New to StockPilot?');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('team-invite');
    const res = render();
    expect(res.subject).toBe(def.subject({ org: SEED.org }));
    expect(res.subject).toBe('You’re invited to join L4L North Region on StockPilot');
    expect(res.preheader).toBe(
      def.preheader({
        inviterFirst: 'Branden',
        roleWithArticle: 'a Warehouse User',
        window: '7 days',
      }),
    );
    expect(res.html).toContain(res.preheader);
  });

  it('sends from the registry hello@ sender', () => {
    const res = render();
    expect(res.from).toBe('StockPilot <hello@stockpilotusa.com>');
    expect(res.replyTo).toBeUndefined();
  });

  it('uses the essential footer naming the inviter', () => {
    const res = render();
    assertEssentialFooter(res.html);
    expect(res.html).toContain(
      'because branden@l4lnorth.com invited this address to a StockPilot workspace',
    );
  });

  it('is static — no motion hero (registry: None · static workspace card)', () => {
    assertNoMotionHero(render().html);
  });

  it('stress: long org name + missing inviter email + hostile org stay safe', () => {
    const res = renderTeamInviteEmail({
      email: 'exceptionally.long.invitee.address@very-long-subdomain.example-warehouse-operations.com',
      org: `${LONG_ORG} <script>x</script>`,
      inviterName: 'Branden',
      role: 'viewer',
      acceptUrl: SEED.acceptUrl,
      expiresOn: SEED.expiresOn,
    });
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('Pacific Intermountain Distribution &amp; Logistics');
    // No inviter email → footer names the inviter by name instead.
    expect(res.html).toContain('because Branden invited this address');
    // Single-word inviter → single-letter initials, first word reused.
    expect(res.html).toContain('>B</div>');
    expect(res.html).toContain('Read-Only Auditor');
  });
});

describe('invite-reminder (renderInviteReminderEmail)', () => {
  const render = () =>
    renderInviteReminderEmail({
      email: SEED.inviteeEmail,
      org: SEED.org,
      inviterName: SEED.inviterName,
      inviterEmail: SEED.inviterEmail,
      role: 'staff',
      acceptUrl: SEED.acceptUrl,
      expiresOn: SEED.expiresOn,
      appUrl: SEED.appUrl,
    });

  it('is explicitly a reminder carrying the NEW expiry', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('Still thinking it over?');
    expect(res.html).toContain('Your invitation is waiting.');
    expect(res.html).toContain('a nudge, not a new invitation');
    expect(res.html).toContain('It now expires');
    expect(res.html).toContain('Wed, Jun 3');
    expect(res.html).toContain('Reminder · still pending');
    expect(res.html).toContain('>Accept invitation &rarr;</a>');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('invite-reminder');
    const res = render();
    expect(res.subject).toBe(def.subject({ org: SEED.org }));
    expect(res.subject).toBe('Reminder: you’re invited to join L4L North Region on StockPilot');
    expect(res.preheader).toBe(def.preheader({ expiresOn: SEED.expiresOn }));
    expect(res.html).toContain(res.preheader);
  });

  it('sends from the registry hello@ sender with the essential footer', () => {
    const res = render();
    expect(res.from).toBe('StockPilot <hello@stockpilotusa.com>');
    assertEssentialFooter(res.html);
  });

  it('is static — no motion hero (registry: None)', () => {
    assertNoMotionHero(render().html);
  });

  it('stress: long org + missing first name context render safely', () => {
    const res = renderInviteReminderEmail({
      email: SEED.inviteeEmail,
      org: LONG_ORG,
      inviterName: 'ops@l4lnorth.com',
      role: 'admin',
      acceptUrl: SEED.acceptUrl,
      expiresOn: SEED.expiresOn,
    });
    assertNoLeakage(res);
    assertWeight(res);
    // Invitee name is never known on this path — the archetype fallback.
    expect(res.html).toContain('Hi —');
  });
});

describe('ws-ready (renderWorkspaceReadyEmail)', () => {
  const render = () =>
    renderWorkspaceReadyEmail({
      email: SEED.inviterEmail,
      org: SEED.org,
      openUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=pkce_7Ww&type=invite&next=%2Freset%2Fcomplete',
      appUrl: SEED.appUrl,
    });

  it('renders with realistic seed data — steps card + both CTAs', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('Your workspace is ready.');
    expect(res.html).toContain('Let&rsquo;s get it stocked.');
    expect(res.html).toContain('L4L North Region');
    expect(res.html).toContain('Invite your team');
    expect(res.html).toContain('Configure inventory');
    expect(res.html).toContain('Place a first order');
    expect(res.html).toContain('>Open workspace &rarr;</a>');
    expect(res.html).toContain('https://stockpilotusa.com/dashboard/team');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('ws-ready');
    const res = render();
    expect(res.subject).toBe(def.subject({ org: SEED.org }));
    expect(res.subject).toBe('Your L4L North Region workspace on StockPilot is ready');
    expect(res.preheader).toBe(def.preheader({}));
    expect(res.html).toContain(res.preheader);
  });

  it('sends from the registry hello@ sender with the essential footer', () => {
    const res = render();
    expect(res.from).toBe('StockPilot <hello@stockpilotusa.com>');
    assertEssentialFooter(res.html);
    expect(res.html).toContain('the owner of this new StockPilot workspace');
  });

  it('embeds the tiles hero with reserved dimensions and alt text', () => {
    const res = render();
    expect(res.html).toContain('https://stockpilotusa.com/email/motion/tiles@2x.gif');
    expect(res.html).toContain('width="528" height="194"');
    expect(res.html).toMatch(/alt="[^"]*provisioned and ready[^"]*"/);
  });

  it('stress: long + hostile org name stays escaped and under budget', () => {
    const res = renderWorkspaceReadyEmail({
      email: SEED.inviterEmail,
      org: `${LONG_ORG} & "Partners" <east>`,
      openUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=pkce_7Ww&type=invite',
    });
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).not.toContain('<east>');
    expect(res.html).toContain('&amp; &quot;Partners&quot; &lt;east&gt;');
  });
});

describe('portal-invite (renderPortalInviteEmail)', () => {
  const render = () =>
    renderPortalInviteEmail({
      email: SEED.customerEmail,
      supplierOrg: SEED.org,
      customerOrg: SEED.customerOrg,
      portalUrl: SEED.portalUrl,
      supplierReplyTo: SEED.inviterEmail,
      appUrl: SEED.appUrl,
    });

  it('renders for an external reader — portal card, magic-link banner, help row', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('L4L North Region invited you to order online.');
    expect(res.html).toContain('Their catalog, your account.');
    expect(res.html).toContain('L4L North Region — supplier portal');
    expect(res.html).toContain('Access for Harbor &amp; Pine Outfitters &middot; maya@harborpine.example');
    // Magic-link semantics explained for a reader with zero StockPilot context.
    expect(res.html).toContain('How this link works');
    expect(res.html).toContain('It signs you in securely — no password to create.');
    expect(res.html).toContain('It&rsquo;s personal to maya@harborpine.example');
    expect(res.html).toContain('Didn&rsquo;t expect this?');
    expect(res.html).toContain('>Open the portal &rarr;</a>');
    // Benefit list.
    expect(res.html).toContain('Browse the live catalog with current availability');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('portal-invite');
    const res = render();
    expect(res.subject).toBe(def.subject({ org: SEED.org }));
    expect(res.subject).toBe('You’re invited to order from L4L North Region’s supplier portal');
    expect(res.preheader).toBe(def.preheader({}));
    expect(res.html).toContain(res.preheader);
  });

  it('sends as "<Org> via StockPilot <portal@...>" with replies to the supplier', () => {
    const res = render();
    // Byte-equal to the registry sample-world sender.
    expect(res.from).toBe('L4L North Region via StockPilot <portal@stockpilotusa.com>');
    expect(res.replyTo).toBe('branden@l4lnorth.com');
  });

  it('quotes RFC-5322-unsafe display names and strips injection characters', () => {
    expect(portalInviteFrom('Harbor & Pine, Inc.')).toBe(
      '"Harbor & Pine, Inc. via StockPilot" <portal@stockpilotusa.com>',
    );
    expect(portalInviteFrom('Evil\r\nBcc: x@y.z <a@b.c>')).toBe(
      '"EvilBcc: x@y.z a@b.c via StockPilot" <portal@stockpilotusa.com>',
    );
  });

  it('uses the external footer — explainer, contact-the-sender, no unsubscribe', () => {
    const res = render();
    expect(res.html).toContain('No StockPilot account is required.');
    expect(res.html).toContain('>Contact the sender</a>');
    expect(res.html).toContain('mailto:branden@l4lnorth.com');
    expect(res.html).not.toContain('>Unsubscribe</a>');
    expect(res.html).not.toContain('Manage email preferences');
    // Essential-footer boilerplate must not leak onto external mail.
    expect(res.html).not.toContain('can&rsquo;t be unsubscribed');
  });

  it('is static — registry motion "L2 · Catalog tiles" has no asset', () => {
    assertNoMotionHero(render().html);
  });

  it('avoids claiming a link duration it cannot verify (no expiry passed)', () => {
    const res = render();
    expect(res.html).toContain('if it stops working, request a fresh one from L4L North Region');
    expect(res.html).not.toContain('works for');
  });

  it('states the duration when the caller can vouch for one', () => {
    const res = renderPortalInviteEmail({
      email: SEED.customerEmail,
      supplierOrg: SEED.org,
      customerOrg: SEED.customerOrg,
      portalUrl: SEED.portalUrl,
      linkExpiry: '14 days',
    });
    expect(res.html).toContain('and works for 14 days; after that, request a fresh one');
  });

  it('stress: long supplier + hostile customer org + no reply-to stay safe', () => {
    const res = renderPortalInviteEmail({
      email: 'exceptionally.long.customer.address@very-long-subdomain.example-buyer-operations.com',
      supplierOrg: LONG_ORG,
      customerOrg: '<img src=x onerror=alert(1)>',
      portalUrl: SEED.portalUrl,
    });
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).not.toContain('<img src=x');
    expect(res.replyTo).toBeUndefined();
    // Without a supplier address the contact link falls back to support.
    expect(res.html).not.toContain('mailto:');
  });
});
