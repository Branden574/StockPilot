/**
 * StockPilot email system — INVITATIONS family
 * (team-invite, invite-reminder, ws-ready, portal-invite).
 *
 * Composed exclusively from the shared es component layer following the
 * security archetype's markup patterns; `docs/design/email-system/
 * es-invites.jsx` is the visual reference. Subjects / preheaders come
 * from the registry builders VERBATIM.
 *
 * Senders (registry): team-invite / invite-reminder / ws-ready send from
 * `StockPilot <hello@stockpilotusa.com>` (reply-to not monitored);
 * portal-invite sends from `<Org> via StockPilot <portal@stockpilotusa.com>`
 * with replies routed to the supplier when an address is available.
 *
 * Motion: ws-ready embeds the tiles asset. team-invite / invite-reminder
 * are static per the registry. portal-invite's registry motion note
 * ("L2 · Catalog tiles") has NO corresponding MOTION asset — static until
 * the motion board gains one (flagged in the registry).
 */

import { ROLE_LABELS, type Role } from '@stockpilot/core';

import {
  assertEmailWeight,
  banner,
  bodyText,
  brandStrip,
  card,
  ctaRow,
  emailShell,
  escapeHtml,
  footer,
  headline,
  helpRow,
  heroSlot,
  linkFallback,
  logoMarkImg,
  section,
  statusPill,
  workspaceCard,
} from '../components';
import { esEmailById } from '../registry';
import { ES_LIGHT, ES_MONO_INLINE, esAssetUrl } from '../tokens';

import type { RenderedEsEmail } from './security';

const L = ES_LIGHT;
const DEFAULT_APP_URL = 'https://stockpilotusa.com';

function marketingUrls(appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  return {
    home: base,
    support: `${base}/support`,
    privacy: `${base}/privacy`,
    terms: `${base}/terms`,
  };
}

/** First word of a full name (or the whole value when single-token). */
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName.trim();
}

/** "BW" from "Branden Vincent Walker"; single-token values use their first letter. */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return 'SP';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase() || 'SP';
}

/** "a Warehouse User" / "an Operator" — the article travels with the label. */
function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** Shared invite workspace card (invite + reminder render the same family card). */
function inviteWorkspaceCard(opts: {
  org: string;
  inviterName: string;
  role: Role;
}): string {
  const roleLabel = ROLE_LABELS[opts.role];
  return workspaceCard({
    initials: escapeHtml(initialsOf(opts.inviterName)),
    orgHtml: escapeHtml(opts.org),
    // The mockup's meta line (industry · members · seats open) needs data
    // the invite path doesn't have — a truthful constant instead of
    // fabricated counts.
    metaHtml: 'Workspace on StockPilot',
    roleName: escapeHtml(roleLabel.label),
    roleBlurbHtml: escapeHtml(roleLabel.description),
  });
}

// ── team-invite ─────────────────────────────────────────────────────

export interface TeamInviteEmailParams {
  /** Recipient address (footer reason). */
  email: string;
  org: string;
  inviterName: string;
  /** Optional; enriches body + footer copy when the caller has it. */
  inviterEmail?: string | null;
  role: Role;
  acceptUrl: string;
  /** Formatted expiry date, e.g. "Wed, Jun 3". */
  expiresOn: string;
  /** Human validity window (registry sample: "7 days"). */
  window?: string;
  appUrl?: string;
}

export function renderTeamInviteEmail(params: TeamInviteEmailParams): RenderedEsEmail {
  const def = esEmailById('team-invite');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const window = params.window ?? '7 days';
  const roleLabel = ROLE_LABELS[params.role];
  const org = escapeHtml(params.org);
  const email = escapeHtml(params.email);
  const acceptUrl = escapeHtml(params.acceptUrl);
  const expiresOn = escapeHtml(params.expiresOn);
  const inviterFirst = firstNameOf(params.inviterName);
  const inviterId = params.inviterEmail?.trim()
    ? `${escapeHtml(params.inviterName)} (${escapeHtml(params.inviterEmail)})`
    : escapeHtml(params.inviterName);

  const subject = def.subject({ org: params.org });
  const preheader = def.preheader({
    inviterFirst,
    roleWithArticle: withArticle(roleLabel.label),
    window,
  });

  const styles = { darkPills: ['warn' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({
      inviterFirst: escapeHtml(inviterFirst),
      roleWithArticle: escapeHtml(withArticle(roleLabel.label)),
      window: escapeHtml(window),
    }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({
            variant: def.badge.variant,
            label: def.badge.label({ window: escapeHtml(window) }),
          }),
          headline({
            lead: `${escapeHtml(inviterFirst)} invited you.`,
            turn: `Join ${org}.`,
          }),
          bodyText(
            `Hi — ${inviterId} added you to their StockPilot workspace as <strong class="ink" style="font-weight:600;color:${L.ink}">${escapeHtml(withArticle(roleLabel.label))}</strong>.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        inviteWorkspaceCard({ org: params.org, inviterName: params.inviterName, role: params.role }),
      ),
      section(
        '0 36px 24px',
        [
          ctaRow({
            primary: { label: def.cta, href: acceptUrl },
            secondary: { label: def.cta2!, href: urls.home },
            noteHtml: `Expires ${expiresOn}. Wasn&rsquo;t expecting this? Ignore it — nothing about you is shared until you accept.`,
          }),
          linkFallback(acceptUrl),
        ].join('\n      '),
      ),
      section(
        '0 36px 30px',
        helpRow(
          `New to StockPilot? It&rsquo;s where ${org} runs inventory, orders, rentals, and schedules. Your account takes about two minutes to set up.`,
        ),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because ${
          params.inviterEmail?.trim() ? escapeHtml(params.inviterEmail) : escapeHtml(params.inviterName)
        } invited this address to a StockPilot workspace.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `${params.inviterName} invited you to join ${params.org} on StockPilot as ${withArticle(roleLabel.label)}.`,
    '',
    `Accept the invitation: ${params.acceptUrl}`,
    '',
    `Expires ${params.expiresOn}. Wasn’t expecting this? Ignore it — nothing about you is shared until you accept.`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── invite-reminder ─────────────────────────────────────────────────

export interface InviteReminderEmailParams {
  email: string;
  org: string;
  inviterName: string;
  role: Role;
  acceptUrl: string;
  /** NEW expiry after the resend bump, e.g. "Wed, Jun 3". */
  expiresOn: string;
  inviterEmail?: string | null;
  appUrl?: string;
}

export function renderInviteReminderEmail(params: InviteReminderEmailParams): RenderedEsEmail {
  const def = esEmailById('invite-reminder');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const org = escapeHtml(params.org);
  const email = escapeHtml(params.email);
  const acceptUrl = escapeHtml(params.acceptUrl);
  const expiresOn = escapeHtml(params.expiresOn);
  const inviterFirst = firstNameOf(params.inviterName);

  const subject = def.subject({ org: params.org });
  const preheader = def.preheader({ expiresOn: params.expiresOn });

  const styles = { darkPills: ['warn' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ expiresOn }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: def.badge.variant, label: def.badge.label({}) }),
          headline({ lead: 'Still thinking it over?', turn: 'Your invitation is waiting.' }),
          bodyText(
            `Hi — a nudge, not a new invitation: ${escapeHtml(inviterFirst)}&rsquo;s invite to join <strong class="ink" style="font-weight:600;color:${L.ink}">${org}</strong> is still open. It now expires <strong class="ink" style="font-weight:600;color:${L.ink}">${expiresOn}</strong>.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        inviteWorkspaceCard({ org: params.org, inviterName: params.inviterName, role: params.role }),
      ),
      section(
        '0 36px 30px',
        [
          ctaRow({
            primary: { label: def.cta, href: acceptUrl },
            noteHtml: `Expires ${expiresOn}. Wasn&rsquo;t expecting this? Ignore it — nothing about you is shared until you accept.`,
          }),
          linkFallback(acceptUrl),
        ].join('\n      '),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because ${
          params.inviterEmail?.trim() ? escapeHtml(params.inviterEmail) : escapeHtml(params.inviterName)
        } invited this address to a StockPilot workspace.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `A nudge, not a new invitation: ${params.inviterName}’s invite to join ${params.org} on StockPilot is still open. It now expires ${params.expiresOn}.`,
    '',
    `Accept the invitation: ${params.acceptUrl}`,
    '',
    'Wasn’t expecting this? Ignore it — nothing about you is shared until you accept.',
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── ws-ready ────────────────────────────────────────────────────────

export interface WorkspaceReadyEmailParams {
  /** New owner's address (recipient + footer reason). */
  email: string;
  org: string;
  /** Sign-in action link ("Open workspace"). */
  openUrl: string;
  firstName?: string | null;
  appUrl?: string;
}

/** Numbered setup-steps card (es-invites.jsx WorkspaceReadyEmail steps). */
function setupStepsCard(): string {
  const steps: [string, string, string][] = [
    ['01', 'Invite your team', 'Operators can scan and count from day one.'],
    ['02', 'Configure inventory', 'Import items or start from the catalog templates.'],
    ['03', 'Place a first order', 'Run one request end-to-end to see the flow.'],
  ];
  const rows = steps
    .map(([n, title, desc], i) => {
      const border = i < steps.length - 1 ? `border-bottom:1px solid ${L.hair};` : '';
      return `<tr>
            <td class="ink4" width="28" style="padding:12px 0;${border}font-family:${ES_MONO_INLINE};font-size:10px;color:${L.ink4};vertical-align:baseline">${n}</td>
            <td style="padding:12px 0;${border}">
              <div class="ink" style="font-size:13.5px;font-weight:600;color:${L.ink}">${title}</div>
              <div class="ink3" style="font-size:12px;color:${L.ink3};margin-top:2px;line-height:1.5">${desc}</div>
            </td>
          </tr>`;
    })
    .join('\n          ');
  return card(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rows}
        </table>`,
    { pad: '6px 20px' },
  );
}

export function renderWorkspaceReadyEmail(params: WorkspaceReadyEmailParams): RenderedEsEmail {
  const def = esEmailById('ws-ready');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const org = escapeHtml(params.org);
  const email = escapeHtml(params.email);
  const openUrl = escapeHtml(params.openUrl);
  const inviteTeamUrl = `${appUrl.replace(/\/$/, '')}/dashboard/team`;
  const name = params.firstName?.trim();
  const greeting = name ? `Hi ${escapeHtml(name)} ` : 'Hi ';

  const subject = def.subject({ org: params.org });
  const preheader = def.preheader({});

  const styles = { darkPills: ['ok' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({}),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: def.badge.variant, label: def.badge.label({}) }),
          headline({ lead: 'Your workspace is ready.', turn: 'Let&rsquo;s get it stocked.' }),
          bodyText(
            `${greeting}— <strong class="ink" style="font-weight:600;color:${L.ink}">${org}</strong> is provisioned and live. Inventory, orders, rentals, and scheduling are all switched on.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/tiles@2x.gif'),
          alt: 'Six workspace tiles settle into place and a check draws — your workspace is provisioned and ready',
          note: 'motion asset: tiles.gif · L3 · plays once, frame 1 = resting composition',
        }),
      ),
      section('0 36px 24px', setupStepsCard()),
      section(
        '0 36px 30px',
        ctaRow({
          primary: { label: def.cta, href: openUrl },
          secondary: { label: def.cta2!, href: inviteTeamUrl },
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> — the owner of this new StockPilot workspace.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `Your ${params.org} workspace on StockPilot is ready.`,
    '',
    'Inventory, orders, rentals, and scheduling are all switched on. Two quick steps finish setup: invite your team, then configure inventory.',
    '',
    `Open your workspace: ${params.openUrl}`,
    `Invite your team: ${inviteTeamUrl}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── portal-invite ───────────────────────────────────────────────────

export interface PortalInviteEmailParams {
  /** External recipient address. */
  email: string;
  /** The SUPPLIER org running the portal (sender display + copy). */
  supplierOrg: string;
  /** The customer company the access is scoped to. */
  customerOrg: string;
  /** Magic-link sign-in URL. */
  portalUrl: string;
  /**
   * Supplier reply address (registry: "Replies go to the supplier").
   * When absent no explicit Reply-To is set.
   */
  supplierReplyTo?: string | null;
  /**
   * Human validity phrase for the magic link (e.g. "14 days"). Omitted
   * when the caller can't verify it — the banner then avoids claiming a
   * specific duration rather than guessing.
   */
  linkExpiry?: string | null;
  appUrl?: string;
}

/** `<Org> via StockPilot <portal@stockpilotusa.com>` with RFC-5322-safe quoting. */
export function portalInviteFrom(supplierOrg: string): string {
  const clean = supplierOrg.replace(/[\r\n<>"]/g, '').trim() || 'StockPilot';
  const display = `${clean} via StockPilot`;
  const needsQuoting = /[(),.:;@\\[\]]/.test(display);
  return `${needsQuoting ? `"${display}"` : display} <portal@stockpilotusa.com>`;
}

/** Portal identity card: mark + portal title + scoped-access meta + benefit list. */
function portalCard(opts: { supplierOrg: string; customerOrg: string; email: string }): string {
  const benefits = [
    'Browse the live catalog with current availability',
    'Place orders and reorder past requests',
    'See delivery records and receipts',
  ];
  const benefitRows = benefits
    .map(
      (b) => `<tr>
            <td width="22" style="padding:4px 0;vertical-align:top;color:${L.status.ok.fg};font-weight:600;font-size:12.5px">&#10003;</td>
            <td class="ink2" style="padding:4px 0;font-size:12.5px;color:${L.ink2};line-height:1.5">${b}</td>
          </tr>`,
    )
    .join('\n          ');
  return card(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="52" style="vertical-align:middle"><div class="sunk" style="width:40px;height:40px;border-radius:10px;background:${L.sunk};border:1px solid ${L.hair};text-align:center;line-height:40px">${logoMarkImg(24)}</div></td>
          <td style="vertical-align:middle">
            <div class="ink" style="font-size:14px;font-weight:600;color:${L.ink}">${escapeHtml(opts.supplierOrg)} — supplier portal</div>
            <div class="ink3" style="font-size:11.5px;color:${L.ink3};margin-top:2px">Access for ${escapeHtml(opts.customerOrg)} &middot; ${escapeHtml(opts.email)}</div>
          </td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;border-top:1px solid ${L.hair}"><tr><td style="padding-top:8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${benefitRows}
          </table>
        </td></tr></table>`,
    { pad: '16px 20px' },
  );
}

export function renderPortalInviteEmail(params: PortalInviteEmailParams): RenderedEsEmail {
  const def = esEmailById('portal-invite');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const supplier = escapeHtml(params.supplierOrg);
  const email = escapeHtml(params.email);
  const portalUrl = escapeHtml(params.portalUrl);

  const subject = def.subject({ org: params.supplierOrg });
  const preheader = def.preheader({});

  const expiryClause = params.linkExpiry?.trim()
    ? ` and works for ${escapeHtml(params.linkExpiry)}; after that, request a fresh one from ${supplier}`
    : `; if it stops working, request a fresh one from ${supplier}`;

  const styles = { darkPills: ['purple' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({}),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: def.badge.variant, label: def.badge.label({}) }),
          headline({
            lead: `${supplier} invited you to order online.`,
            turn: 'Their catalog, your account.',
          }),
          bodyText(
            `Hi — ${supplier} set up a private ordering portal for <strong class="ink" style="font-weight:600;color:${L.ink}">${escapeHtml(params.customerOrg)}</strong>. Browse their live catalog, place orders, and track deliveries in one place.`,
          ),
        ].join('\n      '),
      ),
      // Registry motion "L2 · Catalog tiles" has no MOTION asset — static.
      section(
        '0 36px 24px',
        portalCard({
          supplierOrg: params.supplierOrg,
          customerOrg: params.customerOrg,
          email: params.email,
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'info',
          titleHtml: 'How this link works',
          bodyHtml: `It signs you in securely — no password to create. It&rsquo;s personal to ${email}${expiryClause}.`,
        }),
      ),
      section(
        '0 36px 24px',
        [
          ctaRow({ primary: { label: def.cta, href: portalUrl } }),
          linkFallback(portalUrl),
        ].join('\n      '),
      ),
      section(
        '0 36px 30px',
        helpRow(
          `Didn&rsquo;t expect this? Someone at ${supplier} may have entered your address for ordering — check with them directly, or just ignore this email.`,
        ),
      ),
      footer({
        kind: 'ext',
        reasonHtml: `You&rsquo;re receiving this because ${supplier} uses StockPilot to run their supplier portal and invited this address. No StockPilot account is required.`,
        urls: {
          contact: params.supplierReplyTo?.trim()
            ? `mailto:${escapeHtml(params.supplierReplyTo)}`
            : urls.support,
          support: urls.support,
          privacy: urls.privacy,
        },
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `${params.supplierOrg} set up a private ordering portal for ${params.customerOrg}. Browse their live catalog, place orders, and track deliveries in one place.`,
    '',
    `Open the portal (this secure link signs you in — no password needed): ${params.portalUrl}`,
    '',
    `Didn’t expect this? Someone at ${params.supplierOrg} may have entered your address for ordering — check with them directly, or just ignore this email.`,
  ].join('\n');

  return {
    id: def.id,
    subject,
    preheader,
    html,
    text,
    from: portalInviteFrom(params.supplierOrg),
    ...(params.supplierReplyTo?.trim() ? { replyTo: params.supplierReplyTo.trim() } : {}),
  };
}
